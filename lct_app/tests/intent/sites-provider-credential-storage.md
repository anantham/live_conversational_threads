# Saved provider keys and model catalogs

- Saving a key encrypts it in browser IndexedDB, automatically fetches its provider catalog, and keeps both across reloads on the same origin.
- Refresh replaces the cached catalog. Removing or replacing a key removes its catalog, and a stale response cannot restore it.
- The dropdown uses the fetched list and preserves saved manual choices. During hydration, processing cannot silently switch from a saved personal key to the Site key.
- Confirm that IndexedDB holds ciphertext and a nonextractable key in Chrome. Neither Web Storage nor other tabs receive the credential as a notification payload.
