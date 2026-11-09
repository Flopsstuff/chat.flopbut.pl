# chat.flopbut.pl

A private chat with a bot, open by invitation only.

- Sign-in with Google through Firebase Authentication.
- Access by invite links, each with a limit on how many accounts can join through it. The first
  sign-in of a new account takes one place; signing in again does not.
- One conversation per account, stored in Firebase Realtime Database.
- The owner issues invites, manages members and can read every conversation.
- The bot is a language model reached through OpenRouter with the Vercel AI SDK, and each chat
  has a spending allowance.
- Its knowledge base, notes about Flop Butylkin with their photos, lives in a private Cloud
  Storage bucket; the owner pushes it there from a local folder with `scripts/kb-push.sh`.
- When the knowledge base has no answer and it matters, the bot asks Flop himself in Telegram
  and brings his answer back to the chat, at once or later.

## Stack

| Piece   | Choice                                              |
| ------- | --------------------------------------------------- |
| Hosting | Google Cloud Run, `europe-west1`, project `flopbut` |
| Auth    | Firebase Authentication, Google provider            |
| Data    | Firebase Realtime Database                          |
| Files   | Cloud Storage, the knowledge base                   |
| Server  | Node, Hono, TypeScript, Firebase Admin SDK          |
| Client  | Vite, React, TypeScript                             |
| Tooling | pnpm, Biome, GitHub Actions                         |

Design follows [flopbut.pl](https://flopbut.pl): patina on ink, Geologica, Golos Text and IBM Plex
Mono.

Raster images are stored in Git LFS, so install `git-lfs` before committing one.

## License

The code is under the [MIT License](LICENSE). The name Flop Butylkin, the brand and the knowledge
base (which is not in this repository) are not.
