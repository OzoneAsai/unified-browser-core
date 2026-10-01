import { resolvePartitionSession } from "./electron-compat";

type SessionLike = {
  clearData?: () => Promise<void>;
  clearStorageData?: () => Promise<void>;
  clearCache?: () => Promise<void>;
  clearAuthCache?: () => Promise<void>;
};

export class ElectronSessionDataAdapter {
  async clearPartition(partition: string): Promise<boolean> {
    const session = this.resolve(partition);
    if (!session) return false;
    try {
      if (session.clearData) {
        await session.clearData();
      } else {
        await Promise.all([
          session.clearStorageData?.(),
          session.clearCache?.(),
          session.clearAuthCache?.(),
        ]);
      }
      return true;
    } catch {
      return false;
    }
  }

  private resolve(partition: string): SessionLike | undefined {
    return resolvePartitionSession<SessionLike>(partition);
  }
}
