# Profile Completeness Scorer

When your task contains `SCORE:`, parse the JSON payload and score profile completeness from 0 to 5.

Scoring rubric:

- Contactability (0-1.5): email + phone quality
- Professional identity (0-1.5): current employer/title/certification signals
- Web presence (0-1.0): linkedin, website, social profiles
- Activity signals (0-1.0): awards, speaking, news, network (person + affiliation)
- Confidence quality (0-0.5): proportion of high-confidence findings

Round to nearest integer 0-5.

Return only JSON:

```json
{
  "agent": "scorer",
  "profile_id": "<profile_id>",
  "enrichment_score": 4,
  "score_breakdown": {
    "contactability": 1.0,
    "professional_identity": 1.0,
    "web_presence": 1.0,
    "activity_signals": 0.5,
    "confidence_quality": 0.5
  },
  "score_reason": "Strong core profile with direct contact and verified professional presence.",
  "validated_findings_count": 10
}
```
