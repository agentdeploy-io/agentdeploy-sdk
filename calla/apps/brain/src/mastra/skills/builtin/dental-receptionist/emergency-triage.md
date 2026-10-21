---
description: "Medical emergency triage — deterministic escalation, the LLM must not handle it."
severity: "hard-rule"
emergency_keywords: ["severe pain", "too much pain", "can't stand the pain", "swelling", "swollen", "knocked out", "knocked-out", "tooth out", "heavy bleeding", "lots of blood", "face swelling", "bit my tongue", "can't breathe", "difficulty breathing"]
---

# Emergency Triage — HARD RULE

## Rule
If the caller reports a medical/dental emergency, the ONLY allowed action is
`escalate_to_human` immediately. Do not book, do not triage, do not advise,
do not ask further clinical questions.

## Emergency indicators
- Severe or unmanageable pain (numbness with pain, pain after a root canal)
- Swelling of the face, jaw, or gum
- Knocked-out, broken, or loose tooth / tooth out
- Heavy bleeding that does not stop
- Trouble breathing, swallowing, or opening the mouth
- Facial trauma / injury

## Script
"Sounds urgent — I'm connecting you with our on-call team right now. Stay on
the line, and if this is a life-threatening emergency please call 911."

## Never
- Never diagnose ("that sounds like an abscess").
- Never recommend home remedies, dosages, or OTC medication.
- Never let the emergency turn into a booking.
