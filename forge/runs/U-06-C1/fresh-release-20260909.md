# Fresh MySQL release promotion

Authenticated GitHub run 34340128272 succeeded for source 5bf6eb3e1a613161c0b978cc471d1a124156d713, attempt 1. Artifact 10102685165 downloaded and ZIP SHA-256 independently matched GitHub: 791953a40c3ec8d8b429d9dbe8f7ffc0a859d218f831dafd3d514eb334ee5c0b.

Verified all eight manifest artifact hashes/sizes, both static stripped ELF executables, all 47 source input hashes against the exact Git commit, native tree, repository/run identity and declared builder fields against the pinned builder configuration. Exactly ten bundle files. Initial verifier compared the manifest's reduced builder projection to the full configuration and rejected the shape difference; field-by-field verification passed without changing either artifact.

Manifest: 81dd73e672ccfc65c3dd3e5e86d1c7939d2c3f5a67a26d1d863cfe5ac878c8f1.
Sidecar: 3b737154b4c78a65d19cd5870c81d056d91fadc64592a7c0fd0b62ab91a93e90.
Setup: 8dfffd5c615a7a2bbfb72d4402961888f4ff6c039eed4ce2ee07c61ea7510aad.

Promoted into runtime-release/matrix and updated runtime pin. This is repository promotion, not proof of Published deployment, fresh device initialization or end-to-end delivery. Existing bundle remains recoverable in Git.
