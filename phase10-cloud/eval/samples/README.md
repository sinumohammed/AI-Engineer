# Test files for attachments and voice input

Made for testing, all fictional or computer-generated - except `irs-pub15-employers-tax-guide.pdf`, a real public-domain IRS publication used as a long file.

## Attachments (the paperclip in the chat app)

| File | What it is | Try asking |
|---|---|---|
| `travel-policy.pdf` | A made-up 3-page travel policy with real text, one fact per page | "What is the hotel limit in Paris?" (page 2: 220 euros) · "How many days before departure must flights be booked?" (page 1: 14 days, and the handbook has its own rule, so you get both) · "When must receipts be submitted?" (page 3: within 30 days) |
| `scanned.pdf` | Page 2 of the same policy as an image only, with no text layer, like a scan | "What is the daily meal allowance in Europe?" (45 euros). It is read by Gemini, not by text extraction. |
| `irs-pub15-employers-tax-guide.pdf` | IRS Publication 15 (Circular E), Employer's Tax Guide for 2026: 59 pages, ~300,000 characters of text, public domain (from irs.gov). Too long to read whole, so it is searched per question (attachments step 2) | "What is the FUTA tax rate for 2026?" (page 44: 6.0% of the first $7,000) · "When do I have to start withholding Additional Medicare Tax?" (page 30: over $200,000) · "What happens if I accumulate $100,000 or more in tax liability on any day?" (pages 33-35: deposit by the next business day). `npm run eval:long-file` in `eval/` |
| `receipt.png` | A photo-style café receipt in Italian | "What was the total and how did I pay?" (16.90 EUR, VISA ending 4821) · "How much were the cappuccinos?" (6.40) |

## Voice input (the microphone)

Play one of these near your microphone while recording, or upload it directly:

```
curl -X POST "http://localhost:3002/api/transcribe?lang=Malayalam" \
  -H "Content-Type: audio/mp4" --data-binary @voice-malayalam-comp-time.m4a
```

| File | Said | Set "I speak:" to |
|---|---|---|
| `voice-malayalam-comp-time.m4a` | കോമ്പ് ടൈം എപ്പോഴാണ് കാലഹരണപ്പെടുന്നത്? (When does comp time expire?) | Malayalam |
| `voice-malayalam-rollback.m4a` | ഞങ്ങളുടെ റോൾബാക്ക് പ്രക്രിയ എന്താണ്? (What is our rollback process?) | Malayalam |
| `voice-hindi-parental-leave.m4a` | मुझे कितनी सवेतन पैरेंटल लीव मिलती है? (How much paid parental leave do I get?) | Hindi |
| `voice-english-parental-leave.m4a` | How much paid parental leave do I get? | detect automatically |

The Malayalam recordings were made with Gemini's text-to-speech, since macOS has no Malayalam voice. The Hindi and English ones were made with macOS `say`. A real voice is the better test.
