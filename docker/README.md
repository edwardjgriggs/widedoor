# docker/

Files the Widedoor image and its `docker run` commands use.

- `chromium-seccomp.json`: Docker's default seccomp profile plus one rule, for web scans (see
  the Docker section of the main README).
- `THIRD-PARTY-NOTICES.txt`: copied into the image as `/app/THIRD-PARTY-NOTICES.txt`.

## Regenerating the seccomp profile

The profile is Docker's default from `github.com/moby/profiles/seccomp` v0.2.3 (the version
moby `docker-v29.6.1` vendors; raw file SHA-256
`536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`), with one rule appended
at the end:

```json
{
  "names": ["chroot", "clone", "unshare"],
  "action": "SCMP_ACT_ALLOW",
  "comment": "Widedoor: lets Chromium build its user, PID and network namespace sandbox without CAP_SYS_ADMIN (clone and unshare with namespace flags, chroot inside the new user namespace)."
}
```

Docker may tighten its default in later releases, and this copy then stays weaker than the
engine's own default. To move to a newer default:

1. Download `seccomp/default.json` from `https://github.com/moby/profiles` at the new tag (or
   `vendor/github.com/moby/profiles/seccomp/default.json` from the moby release the profile
   should match) and record its SHA-256.
2. Append the rule above as the last entry of `syscalls`, change nothing else, and run
   `npx prettier --write docker/chromium-seccomp.json`.
3. In `packages/cli/test/dockerfile.test.ts`, update the expected hash. It is the SHA-256 of
   `JSON.stringify(JSON.parse(<downloaded file>))`.
4. Update the version in this file, the main README and NOTICE, then run `npm test` and
   `npm run test:image`.
