# V8 Heap / Context injection research (2026-10-16)

Status: **FROZEN research prototype; not integrated or automatically executed**. No changes to the production UBC browser, passwords, Discord, or actual website heaps. This directory uses synthetic state and a standalone V8 runtime linked through the machine's installed Node.js.

## 日本語サマリー

- **独立プロセスへ本物の V8 Context Snapshot を注入：成功。** JavaScript のクロージャを維持しながら、`Document` と `Element` 相当の C++ オブジェクトを論理 ID で復元先に再接続。生のポインターは保存しない。
- **JavaScript + ネイティブイベント状態のハイブリッド復元：合成モデルで成功。** Snapshot に残った JS 関数とイベント登録情報を使い、新しいネイティブ EventTarget へ4件再登録。C++ 側のイベント配送で、復元済みクロージャが呼び出されることを確認。
- **異なるオリジンへの誤接続：拒否成功。** ブラウザーの正式な SecurityOrigin 処理ではなく、PoC 用の数値オリジン識別子での検証。
- **生きている Heap の部分操作：成功。** Inspector の Heap Object ID によって、既存 JavaScript オブジェクトの再取得・変更が可能。ただし保存済み Heap 全体の再注入ではない。
- **実サイトを完全復元：未実証。** Blink の DOM/イベント登録、フレーム、ワーカー、タスクキュー、GPU/ネットワーク、権限・CSP の整合的な復元は別途必要。Chromium/Electron のカスタムビルドが必要になる見込み。

## 次の Chromium フォーク研究の判断ゲート

1. **事前ゲート：** `content_shell` の専用ビルドで、変更なしの `v8_context_snapshot_generator` → `V8ContextSnapshotImpl::CreateContext` を再現。Obsidian のアプリ本体や同梱 `.bin` は絶対に書き換えない。
2. **捕捉ゲート：** 既存のサイト実行用 V8 Isolate が SnapshotCreator の生成・管理条件を満たすか、改造なしでは満たせない理由を切り分ける。ページ実行中の任意 Heap を安全なタイミングで捕捉できなければ、それ以上の実装に進まない。
3. **再接続ゲート：** 単一フレームの合成 Document と Element を、ブラウザー自身のネイティブライフサイクルに従って再構築。`LocalWindowProxy` の global proxy、`ScriptState`、SecurityOrigin、CSP、microtask queue を再設定。
4. **イベントゲート：** `EventTargetData` / `EventListenerMap` の登録を、関数参照・options・イベント型・対象 Node とともに復元。実際の JavaScript イベント処理が再起動後も動作することをテストする。
5. **拡張ゲート：** iframe / OOPIF / worker / native timer / pending Promise / WebSocket / WebRTC / Storage について保存可能性を個別判定。途中で一部の状態が落ちる場合は**不完全な実行継続を成功と扱わず**、通常の URL 復元へフォールバックする。
6. **安全性ゲート：** Blob のエンジン・バージョン・CPU・外部参照表の互換性を検証。オリジン情報は Blob の自己申告を信用せず、Browser が検証した情報と比較。異なるサイトの Heap を混ぜない。不要な Snapshot の破棄・メモリ上限・既存パスワード保管庫との分離を必須とする。

現段階で UBC 本番に Snapshot 保存機能を追加することは推奨しません。合成 PoC が通ったことと、一般の Web サイトを復元できることは別です。

## Findings backed by executable experiments

Run on a Mac with Homebrew Node.js / `libnode` and `clang++`:

```bash
bash research/v8-heap-injection/run-macos.sh
```

1. **V8 Context Snapshot + host object rebinding: YES.** A context containing a closure, an object that looks like `document`, and a C++ native function is written as a binary snapshot (~538 KB here). In a **different OS process** the Snapshot is loaded into a fresh V8 Isolate and a custom `DeserializeInternalFieldsCallback` rebinds the surviving JS wrappers to **new C++ objects** (`Document` version 12→99; `Element` version 7→66). The serializer stores **stable resource IDs**, not C++ pointer addresses; the receiving process constructs its own ID-to-native-object map. The closure's private counter resumes at 41 and its captured wrapper identity is unchanged. The synthetic native `EventTarget` has **3 listener registrations before saving**, but the new native object has **0** immediately after context restoration despite the surviving JS closure and wrapper. Neither event-dispatch registrations nor other native subsystem state is automatically serialized. As a **second, explicit phase**, the prototype replays synthetic listener metadata retained in JS state into new native EventTargets: 3 Document listeners and 1 Element listener are re-registered. C++ then dispatches these 4 native events back into the restored JS functions; the hidden closure state advances normally (last reported value: **47**). This proves a limited combined reconstruction mechanism, **not** real Blink EventTarget restoration. It proves the demonstration does not magically restore embedder state. This is a miniature analogue of Blink's existing `V8ContextSnapshotImpl` mechanism. It is not an actual browser Document or a runnable Browser renderer checkpoint.
2. **Live Heap object manipulation: YES, with limits.** Node.js Inspector (`HeapProfiler.startTrackingHeapObjects`, `getHeapObjectId`, `getObjectByHeapObjectId`, `Runtime.callFunctionOn`) re-identifies a synthetic live object after the Inspector's previous runtime handle is released and updates it in place. No V8 snapshot restoration occurs. Heap IDs are not persistent application object identifiers.
3. **Profiler `.heapsnapshot` import for execution: NO public API found.** Electron exposes `webContents.takeHeapSnapshot(path)` and CDP offers `HeapProfiler.takeHeapSnapshot`, both analysis-oriented. There is no corresponding runtime Heap-replacement / load-profiler-snapshot command. V8 `StartupData` is a different, version/build-sensitive format.
4. **Origin mismatch rejection: YES in the synthetic proof.** Snapshot native resource IDs are namespaced to a synthetic origin ID. A different origin in the destination native graph causes the rebind callback to reject it, and the recovered context is discarded without running its saved JavaScript. Real Chromium requires its own SecurityOrigin, agent cluster, CSP and world checks; numeric IDs here are only a model.
5. **Existing Electron WebView/Chromium main-world Heap restoration: NOT demonstrated.** Browser JavaScript APIs and a native addon running in the Obsidian renderer do not grant access to Blink's C++ Isolate initialization path. Direct substitution of a blob into a running `<webview>` is not supported by documented Electron APIs.

## Key Chromium implementation locations

- `third_party/blink/renderer/bindings/modules/v8/v8_context_snapshot_impl.cc`: `TakeSnapshotForWorld`, `SerializeAPIWrapperCallback`, `DeserializeAPIWrapperCallback`, `CreateContext`. The factory stores *main* and *isolated* world templates and bridges HTMLDocument's JS wrapper to the **current** native Document on deserialization. In current code, the main world snapshot is restricted to HTMLDocument and returns an empty context for unsupported document types.
- `third_party/blink/renderer/bindings/core/v8/local_window_proxy.cc`: `LocalWindowProxy::CreateContext` tries `V8ContextSnapshot::CreateContextFromSnapshot` while creating the frame's JS context, then establishes `ScriptState`, `Window` global proxy, security origin/CSP, conditional runtime features, and microtask queue. **Crucial place to extend for a Chromium fork.** A plugin cannot patch this method at runtime.
- `tools/v8_context_snapshot`: build-time context snapshot generator and GN flags. Generated snapshot is not the runtime Heap of an arbitrary third-party website.
- `third_party/blink/renderer/core/dom/events/event_target.h`: Blink's native `EventTargetData` keeps an `EventListenerMap`. Preserving a V8 callback's closure does not reproduce the listener registration to a newly created native EventTarget.
- `gin/isolate_holder.cc`: renderer Isolate creation and snapshot configuration. Capturing a live renderer Isolate through `SnapshotCreator` is not an exposed, existing operation; the Isolate's construction/lifecycle would need redesign.

## Remaining technical barriers for actual browser checkpoint/resume

The C++ example captures *only two synthetic C++ native wrappers*. A real Blink page also has `DOMWindow`, every `Node`/Element wrapper, Shadow DOM, event listeners, mutation observers, timers, unresolved promises/microtasks, workers and associated threads, network / WebSocket / WebRTC state, compositor/rendering resources, cross-origin frames, site security policies, and GC-managed native (Oilpan) objects. A plain V8 blob does not snapshot those native resources. Their reconstruction requires coherent **logical resource IDs**, deterministic rebinding, secure-origin checks, and coordinated freeze of multiple renderer processes. V8 function closures may be preserved without making the restored DOM internally consistent.

A feasible *experimental fork* would: (1) freeze a **synthetic same-origin single-frame page** at a safe point; (2) serialize a V8 context using a SnapshotCreator-compatible renderer lifecycle; (3) persist a separate minimal native-DOM model; (4) recreate the Document and native objects; (5) rebind all wrapper fields through deserialization callbacks; (6) restore the Context during `LocalWindowProxy` setup, before site scripts run; (7) verify security invariants, lexical closures, DOM identity, event listeners and timers. This calls for a custom Chromium/Electron build, not merely a UBC plugin change.

A read-only inspection of Obsidian 1.10.6 on macOS found Electron's bundled `v8_context_snapshot.arm64.bin` and `v8_context_snapshot.x86_64.bin` (each 718,769 bytes). These are compiled-initialization resources, **not** archived snapshots of visited pages. Do not edit the app bundle or swap those files.

Potential short-term alternative: retain the live WebContents while its tab is hidden, akin to an in-memory tab suspension / BFCache. This avoids serialization and can preserve the JS Heap **only while the OS process remains alive**; it cannot recover after an application restart and requires memory limits and lifecycle policy. Electron officially notes that WebContentsView resources remain alive unless explicitly closed and that embedders are responsible for destruction. It also recommends WebContentsView over the legacy `<webview>` tag; this is relevant to a future UBC backend redesign, but not a substitute for on-disk Heap recovery.

## Security and compatibility

- **Never automatically record live websites' Heap snapshots.** They may contain authentication tokens, passwords, private documents, personal messages and other sensitive values, including strings that were previously used but remain in memory.
- A V8 startup blob should not be interpreted as a portable, safe, untrusted interchange format. Match the exact V8 engine/build and external-reference table, validate integrity, bind only to a permitted origin, and treat loading a crafted blob as potentially dangerous.
- Keep synthetic experiments separate from the real browser partition; no real-user Heap/object inspection or secrets needed to develop the prototype.

## Primary sources

- Blink V8 context snapshot: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/bindings/modules/v8/v8_context_snapshot_impl.cc
- Blink LocalWindowProxy: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/bindings/core/v8/local_window_proxy.cc
- Chromium build-time generator: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/tools/v8_context_snapshot/v8_context_snapshot_generator.cc
- V8 Snapshot C++ API: https://chromium.googlesource.com/v8/v8/+/main/include/v8-snapshot.h
- V8's own serialization tests: https://chromium.googlesource.com/v8/v8/+/main/test/cctest/test-serialize.cc
- Native Blink event listener storage: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/dom/events/event_target.h
- Blink Window creation and origin/CSP rebinding: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/bindings/core/v8/local_window_proxy.cc
- Chrome Heap Profiler: https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/
- Electron WebContents: https://www.electronjs.org/docs/latest/api/web-contents
- Electron WebContentsView lifecycle: https://www.electronjs.org/docs/latest/api/base-window
- Electron web embeds architecture: https://www.electronjs.org/docs/latest/tutorial/web-embeds
- Chrome BFCache: https://developer.chrome.com/docs/devtools/application/back-forward-cache
