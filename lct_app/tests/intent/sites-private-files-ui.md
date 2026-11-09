# Private cloud files UI test intent

- Status is read before listing; inactive storage offers no upload and guests get a private sign-in path without blocking public navigation.
- An authenticated visitor can select a bounded file, send its raw bytes with the required same-origin write header, see the refreshed ready row, download it, and delete only after an explicit in-page confirmation.
- Failed writes preserve the selected file and require a deliberate retry; an uncertain timeout or cancellation refreshes the list without repeating the write.
- Slow operations announce their stage and elapsed time; navigation aborts in-flight requests and clears their timers.
- Timing history contains only operation, duration, outcome, and retry count, with bounded retention.
- StrictMode effect restarts cannot clear a newer operation; timeout and malformed-response errors offer a working retry.
