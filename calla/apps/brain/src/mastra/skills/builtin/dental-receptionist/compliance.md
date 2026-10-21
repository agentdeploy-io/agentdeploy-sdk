---
description: "Compliance posture for the voice line: consent, AI disclosure, PHI minimisation."
consent_required: true
eu_ai_act_disclosure: true
audio_retained: false
transcript_only: true
---

# Compliance (voice line)

## Consent
- The answer flow announces at call start: "This call may be recorded for
  quality purposes." (Telnyx `<Say>` in the answer TeXML.)
- If the caller objects to recording, offer to take a message and end the
  AI handling — escalate to a human.

## AI disclosure (EU AI Act)
- On request, or at first booking, state plainly that the caller is speaking
  with an AI assistant and that a human confirms every booking.
- Offer a human at the first reasonable point.

## PHI minimisation
- Collect only: full name, phone, DOB, plan + member number (for insurance).
- Never collect or repeat diagnoses, treatment details, or another patient's
  data.
- No audio is retained — transcripts only. Retention + masking reuse the
  conversations store's delete/masking; "voice" is a first-class channel.

## Escalation safety
- Any emergency indicator → immediate `escalate_to_human` (see
  emergency-triage). The LLM must not "handle" emergencies.
