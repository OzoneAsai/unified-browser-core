import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { passwordOrigin, parseRecovery, recoveryText, secretBytes, seal, unseal, wrappingKey, type Sealed } from "./crypto";
import { WindowsHello } from "./windows-hello";

export interface PasswordEntry { id: string; origin: string; username: string; password: string; title: string; container?: string; updated: number }
interface Contents { entries: PasswordEntry[]; excluded: string[] }
interface Envelope { version: 1; id: string; recovery: Sealed; hello?: { credential: string; salt: string; wrapped: Sealed }; payload: Sealed; idleMinutes: number }
export class PasswordVault {
  private envelope?: Envelope;
  loadFailed = false;
  private key?: Buffer;
  private contents?: Contents;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  private operations: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  readonly hello = new WindowsHello();
  constructor(private path: string) {}
  async load(): Promise<void> {
    try {
      if ((await stat(this.path)).size > 16 * 1024 * 1024) throw new Error("Password vault is too large");
      this.envelope = validateEnvelope(JSON.parse(await readFile(this.path, "utf8")));
    }
    catch (error: any) { if (error.code !== "ENOENT") this.loadFailed = true; }
  }
  get exists(): boolean { return !!this.envelope || this.loadFailed; }
  get unlocked(): boolean { return !!this.key; }
  get lockEpoch(): number { return this.generation; }
  get usesHello(): boolean { return !!this.envelope?.hello; }
  get idleMinutes(): number { return this.envelope?.idleMinutes ?? 5; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(); }
  touch(): void { clearTimeout(this.timer); if (this.key) this.timer = setTimeout(() => this.lock(), this.idleMinutes * 60000); }
  lock(): void {
    this.generation++; clearTimeout(this.timer); this.key?.fill(0); this.key = undefined;
    if (this.contents) for (const entry of this.contents.entries) entry.password = "";
    this.contents = undefined; this.emit();
  }
  dispose(): void { this.disposed = true; this.lock(); this.hello.dispose(); this.listeners.clear(); }
  setup(useHello: boolean, acknowledge?: (key: string) => Promise<boolean>): Promise<string> { return this.operation(() => this.setupImpl(useHello, acknowledge)); }
  private async setupImpl(useHello: boolean, acknowledge?: (key: string) => Promise<boolean>): Promise<string> {
    if (this.exists) throw new Error("Password vault already exists");
    const generation = this.generation, id = randomUUID(), key = secretBytes(), recovery = secretBytes();
    let credential: string | undefined;
    try {
      const envelope: Envelope = { version: 1, id, recovery: wrap(recovery, key, id, "recovery"), payload: seal(key, Buffer.from(JSON.stringify({ entries: [], excluded: [] })), id + ":payload"), idleMinutes: 5 };
      if (useHello) {
        const salt = secretBytes().toString("base64");
        const created = await this.hello.request("create", { Salt: salt, User: secretBytes().toString("base64") });
        credential = created.Credential;
        if (!credential || !created.Secret) throw new Error("Windows Hello did not return a PRF key");
        const secret = Buffer.from(created.Secret, "base64"); created.Secret = undefined;
        try { envelope.hello = { credential, salt, wrapped: wrap(secret, key, id, "hello") }; } finally { secret.fill(0); }
        // Prove repeat evaluation before making Hello an unlock method.
        const repeated = await this.hello.request("unlock", { Credential: credential, Salt: salt });
        const second = Buffer.from(repeated.Secret || "", "base64"); repeated.Secret = undefined;
        let recovered: Buffer | undefined;
        try { recovered = unwrap(second, envelope.hello.wrapped, id, "hello"); if (!key.equals(recovered)) throw new Error("Windows Hello repeat verification failed"); } finally { second.fill(0); recovered?.fill(0); }
      }
      if (this.generation !== generation) throw new Error("Password vault operation cancelled");
      if (acknowledge && !await acknowledge(recoveryText(recovery))) throw new Error("Password vault setup cancelled");
      if (this.generation !== generation) throw new Error("Password vault operation cancelled");
      await this.persist(envelope);
      this.envelope = envelope;
      if (this.generation === generation) { this.key = Buffer.from(key); this.contents = { entries: [], excluded: [] }; this.touch(); }
      this.emit();
      return recoveryText(recovery);
    } catch (error) { if (credential) try { await this.hello.request("delete", { Credential: credential }); } catch { /* exact orphan credential can be removed in Windows Passkeys */ } throw error; }
    finally { key.fill(0); recovery.fill(0); }
  }
  async unlockHello(): Promise<void> {
    const envelope = this.envelope; if (!envelope?.hello) throw new Error("Windows Hello is not enabled");
    const generation = this.generation;
    const reply = await this.hello.request("unlock", { Credential: envelope.hello.credential, Salt: envelope.hello.salt });
    const secret = Buffer.from(reply.Secret || "", "base64"); reply.Secret = undefined;
    try { this.activate(unwrap(secret, envelope.hello.wrapped, envelope.id, "hello"), generation); } finally { secret.fill(0); }
  }
  unlockRecovery(text: string): void {
    const envelope = this.envelope; if (!envelope) throw new Error("No password vault");
    const secret = parseRecovery(text);
    try { this.activate(unwrap(secret, envelope.recovery, envelope.id, "recovery"), this.generation); } finally { secret.fill(0); }
  }
  private activate(key: Buffer, generation: number): void {
    try {
      if (generation !== this.generation || this.disposed) throw new Error("Password vault operation cancelled");
      const plaintext = unseal(key, this.envelope!.payload, this.envelope!.id + ":payload");
      let contents: Contents;
      try { contents = validateContents(JSON.parse(plaintext.toString())); } finally { plaintext.fill(0); }
      this.key?.fill(0); this.key = Buffer.from(key); this.contents = contents; this.touch(); this.emit();
    } finally { key.fill(0); }
  }
  entries(): PasswordEntry[] { this.requireUnlocked(); this.touch(); return this.contents!.entries.map((entry) => ({ ...entry })); }
  matches(url: string, container: string): PasswordEntry[] {
    if (!this.unlocked) return []; const origin = passwordOrigin(url);
    return this.entries().filter((entry) => entry.origin === origin && (!entry.container || entry.container === container));
  }
  excluded(url: string): boolean { if (!this.unlocked) return true; return this.contents!.excluded.includes(passwordOrigin(url)); }
  save(input: Omit<PasswordEntry, "id" | "updated"> & { id?: string }): Promise<void> { const copy = { ...input }; return this.operation(() => this.saveImpl(copy)); }
  private async saveImpl(input: Omit<PasswordEntry, "id" | "updated"> & { id?: string }): Promise<void> {
    this.requireUnlocked(); const origin = passwordOrigin(input.origin);
    if (!input.password || input.password.length > 8192 || input.username.length > 4096 || input.title.length > 4096) throw new Error("Invalid password entry");
    const previous = input.id ? this.contents!.entries.find((entry) => entry.id === input.id) : this.contents!.entries.find((entry) => entry.origin === origin && entry.username === input.username && entry.container === input.container);
    const entry: PasswordEntry = { ...input, id: previous?.id ?? randomUUID(), origin, updated: Date.now() };
    const contents = { ...this.contents!, entries: this.contents!.entries.filter((item) => item.id !== entry.id).concat(entry) };
    await this.commit(contents);
  }
  remove(id: string): Promise<void> { return this.operation(async () => { this.requireUnlocked(); await this.commit({ ...this.contents!, entries: this.contents!.entries.filter((entry) => entry.id !== id) }); }); }
  exclude(url: string): Promise<void> { return this.operation(async () => { this.requireUnlocked(); await this.commit({ ...this.contents!, excluded: [...new Set(this.contents!.excluded.concat(passwordOrigin(url)))] }); }); }
  clearExcluded(): Promise<void> { return this.operation(async () => { this.requireUnlocked(); await this.commit({ ...this.contents!, excluded: [] }); }); }
  setIdleMinutes(value: number): Promise<void> { return this.operation(async () => { this.requireUnlocked(); if (!Number.isInteger(value) || value < 1 || value > 60) throw new Error("Invalid lock timeout"); await this.commit(this.contents!, value); }); }
  rotateRecovery(acknowledge?: (key: string) => Promise<boolean>): Promise<string> { return this.operation(() => this.rotateRecoveryImpl(acknowledge)); }
  private async rotateRecoveryImpl(acknowledge?: (key: string) => Promise<boolean>): Promise<string> {
    this.requireUnlocked(); const generation = this.generation, recovery = secretBytes(), envelope = { ...this.envelope!, recovery: wrap(recovery, this.key!, this.envelope!.id, "recovery") };
    try { if(acknowledge && !await acknowledge(recoveryText(recovery))) throw new Error("Recovery key replacement cancelled"); this.requireUnlocked(); if(generation !== this.generation)throw new Error("Password vault operation cancelled"); await this.persist(envelope); this.envelope = envelope; this.emit(); return recoveryText(recovery); } finally { recovery.fill(0); }
  }
  enableHello(): Promise<void> { return this.operation(() => this.enableHelloImpl()); }
  private async enableHelloImpl(): Promise<void> {
    this.requireUnlocked(); const generation = this.generation, envelope = this.envelope!, key = Buffer.from(this.key!), salt = secretBytes().toString("base64"); let credential: string | undefined;
    try {
      const created = await this.hello.request("create", { Salt: salt, User: secretBytes().toString("base64") }); credential = created.Credential;
      if (!credential || !created.Secret) throw new Error("Windows Hello unavailable");
      const first = Buffer.from(created.Secret,"base64"); created.Secret = undefined;
      let wrapped: Sealed; try { wrapped = wrap(first,key,envelope.id,"hello"); } finally { first.fill(0); }
      const reply = await this.hello.request("unlock", { Credential: credential, Salt: salt }); const second = Buffer.from(reply.Secret || "","base64"); reply.Secret = undefined;
      let verified: Buffer | undefined; try { verified = unwrap(second,wrapped,envelope.id,"hello"); if (!verified.equals(key)) throw new Error("Windows Hello repeat verification failed"); } finally { second.fill(0); verified?.fill(0); }
      if (generation !== this.generation) throw new Error("Password vault operation cancelled");
      const next = { ...this.envelope!, hello: { credential, salt, wrapped } }; await this.persist(next); const old = this.envelope!.hello; this.envelope = next; this.touch(); this.emit();
      if (old) try { await this.hello.request("delete",{Credential:old.credential}); } catch { /* no weakening on cleanup error */ }
    } catch(error) { if(credential) try { await this.hello.request("delete",{Credential:credential}); } catch {} throw error; }
    finally { key.fill(0); }
  }
  disableHello(): Promise<void> { return this.operation(async () => { this.requireUnlocked(); const previous = this.envelope!.hello; const next = { ...this.envelope! }; delete next.hello; await this.persist(next); this.envelope = next; this.emit(); if(previous) try{await this.hello.request("delete",{Credential:previous.credential});}catch{} }); }
  async exportBackup(): Promise<string> { await this.queue; if(!this.envelope) throw new Error("No password vault"); return JSON.stringify({ ...this.envelope, hello: undefined }, null, 2); }
  importBackup(text: string, recoveryTextValue: string): Promise<void> { return this.operation(() => this.importBackupImpl(text, recoveryTextValue)); }
  private async importBackupImpl(text: string, recoveryTextValue: string): Promise<void> {
    const generation = this.generation;
    if(text.length>16*1024*1024) throw new Error("Backup is too large");
    const imported = validateEnvelope(JSON.parse(text)); delete imported.hello;
    const secret = parseRecovery(recoveryTextValue); let key: Buffer | undefined;
    try {
      key = unwrap(secret,imported.recovery,imported.id,"recovery"); const plain = unseal(key,imported.payload,imported.id+":payload");
      try{validateContents(JSON.parse(plain.toString()));}finally{plain.fill(0);}
      await this.persist(imported); const reopen = this.generation === generation && !this.disposed; const old = this.envelope?.hello; this.lock(); this.envelope=imported; this.loadFailed=false; if(reopen)this.activate(Buffer.from(key),this.generation);
      if(old) try{await this.hello.request("delete",{Credential:old.credential});}catch{}
    } finally{secret.fill(0);key?.fill(0);}
  }
  private requireUnlocked(): void { if (!this.key || !this.contents) throw new Error("Password vault is locked"); }
  private operation<T>(job: () => Promise<T>): Promise<T> {
    const result = this.operations.then(() => { if(this.disposed)throw new Error("Password vault is unavailable");return job(); });
    this.operations = result.then(() => {}, () => {});
    return result;
  }
  private async commit(contents: Contents, idleMinutes = this.idleMinutes): Promise<void> {
    this.requireUnlocked(); const generation = this.generation;
    const bytes = Buffer.from(JSON.stringify(contents)); let payload: Sealed;
    try { payload = seal(this.key!, bytes, this.envelope!.id + ":payload"); } finally { bytes.fill(0); }
    const next = { ...this.envelope!, payload, idleMinutes }; await this.persist(next);
    this.envelope = next; if (this.generation === generation && this.unlocked) { this.contents = contents; this.touch(); } this.emit();
  }
  private persist(envelope: Envelope): Promise<void> {
    const serialized = JSON.stringify(envelope);
    const save = async () => { await mkdir(dirname(this.path), { recursive: true }); const temporary = this.path + ".tmp"; await writeFile(temporary,serialized,{mode:0o600}); await rename(temporary,this.path); };
    const result = this.queue.then(save); this.queue = result.catch(() => {}); return result;
  }
}
function wrap(secret: Buffer,key: Buffer,id: string,kind: "hello" | "recovery"): Sealed { const wrapping = wrappingKey(secret,id,kind); try{return seal(wrapping,key,id+":"+kind);}finally{wrapping.fill(0);} }
function unwrap(secret: Buffer,value: Sealed,id: string,kind: "hello" | "recovery"): Buffer { const wrapping = wrappingKey(secret,id,kind);try{const key=unseal(wrapping,value,id+":"+kind);if(key.length!==32){key.fill(0);throw new Error("Invalid vault key");}return key;}finally{wrapping.fill(0);} }
function validateEnvelope(value: any): Envelope {
  if(value?.version!==1 || typeof value.id!=="string" || value.id.length>128 || !value.recovery || !value.payload || !Number.isInteger(value.idleMinutes) || value.idleMinutes<1 || value.idleMinutes>60) throw new Error("Invalid password vault");
  for(const sealed of [value.recovery,value.payload,value.hello?.wrapped].filter(Boolean)) if(![sealed.nonce,sealed.data,sealed.tag].every(v=>typeof v==="string") || sealed.data.length>24*1024*1024) throw new Error("Invalid encrypted vault");
  if(value.hello && (typeof value.hello.credential!=="string" || typeof value.hello.salt!=="string" || !value.hello.wrapped)) throw new Error("Invalid Hello configuration");
  return value;
}
function validateContents(value: any): Contents {
  if(!Array.isArray(value?.entries) || !Array.isArray(value?.excluded) || value.entries.length>50000 || value.excluded.length>50000) throw new Error("Invalid vault contents");
  for(const entry of value.entries) if(![entry.id,entry.origin,entry.username,entry.password,entry.title].every(v=>typeof v==="string") || (entry.container!==undefined&&typeof entry.container!=="string") || entry.origin!==passwordOrigin(entry.origin) || !Number.isFinite(entry.updated)) throw new Error("Invalid password entry");
  for(const origin of value.excluded) if(typeof origin!=="string"||origin!==passwordOrigin(origin)) throw new Error("Invalid excluded site");
  return value;
}
