# Windows Hello bridge

This small NativeAOT executable calls Windows `webauthn.dll`. It accepts one JSON request over stdin and returns one JSON response over stdout. UBC captures both pipes; authentication secrets are not command-line arguments or log output. It is embedded into the standard BRAT `main.js`, extracted on demand, and checked against its build-time SHA-256 digest before launch.

Build with `npm run build:hello` on Windows with .NET SDK 10 and Visual Studio C++ build tools. The published x64 executable is self-contained; users do not install .NET. Windows ARM64 emulation has not been validated. The binary is unsigned.

Commands: `capabilities`, `create`, `unlock`, `delete`. `create` and `unlock` require Windows user verification and a platform authenticator with WebAuthn PRF support. The bridge verifies the authenticator's RP hash and UP/UV flags; unlock additionally verifies the exact credential ID. Failed or canceled operations return an error and no key. Deletion always specifies an exact credential ID.

Native API layouts follow [Microsoft's webauthn.h](https://github.com/microsoft/webauthn/blob/master/webauthn.h). The PRF key derivation follows the [WebAuthn PRF extension](https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md). The RP is `ubc-passwords.localhost`; it is an identifier for this local native vault, not a contacted server.

Verification: the preceding feasibility probe on this Windows 11 PC registered a PRF-capable Hello credential and decrypted a dummy vault in a fresh process. The production helper builds and reports API version 9 on that PC. Automated vault tests mock native user verification to avoid interrupting the user; they do not replace interactive Hello testing on other machines.
