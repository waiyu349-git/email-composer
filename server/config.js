// Shared runtime config — imported by both index.js and watcher.js
// to avoid circular dependency.
export const runtimeConfig = {
  imapPass: process.env.IMAP_PASS ?? '',
}
