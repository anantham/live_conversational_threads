# Private file storage packaging test intent

- Export only the Site's approved technical source, including the private-file schema, migration history, and logical D1/R2 manifest; exclude unrelated artifacts and private data.
- Reject symlinks before creating an export, including symlinks in newly allowed metadata paths.
- Build output includes the exact hosting manifest and generated migration SQL/metadata while preserving the existing client and Worker output checks.
- Reject missing, malformed, oversized, or unexpected hosting and migration metadata before publication.
