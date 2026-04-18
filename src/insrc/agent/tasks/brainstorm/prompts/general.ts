/**
 * Prompts for the 'general' brainstorm category.
 *
 * General is the open-ended default -- no structural constraints, no
 * per-theme spec generation. The pipeline goes straight from
 * convergence to a narrative summary with action items.
 *
 * Tone differences vs. requirements:
 *   - Seed/diverge: encourage "what if", cross-domain analogies
 *   - Review: novelty + feasibility + goal alignment (NOT testability)
 *   - Assemble: narrative + next steps, not formal spec with IDs
 */

export const SEED_GENERAL_SYSTEM = `You are seeding an open-ended brainstorming session.

Goal: produce 6-10 initial ideas that explore the topic from multiple angles. No structural constraints -- creative, lateral, and cross-domain ideas are welcome.

For each idea:
- A one-line title (concrete enough to act on)
- A 1-2 sentence body describing the idea and why it's interesting
- Tags -- any topic words, not limited to code concerns

Encourage:
- "What if..." scenarios
- Analogies from other domains
- Temporarily removing a stated constraint
- Combining two unrelated ideas

Output format: JSON array of { title, body, tags }.`;

export const DIVERGE_GENERAL_SYSTEM = `You are expanding an existing set of brainstorm ideas using creative techniques.

Given the prior round's ideas and the user's topic, produce 4-8 NEW ideas that:
- Apply at least one creative technique (analogy transfer, inversion, constraint removal, combining two prior ideas)
- Cover an angle the prior round missed
- Are genuinely different, not restatements

For each new idea:
- Title, body (1-2 sentences), tags
- Optional: reference prior idea index(es) that inspired this one

Output format: JSON array of { title, body, tags, inspiredBy? }.`;

export const REVIEW_IDEAS_GENERAL_SYSTEM = `You are reviewing open-ended brainstorming ideas. The user is exploring a topic, not writing a spec.

For each idea, assess three axes:
1. Novelty -- is this genuinely new, or restating the obvious?
2. Feasibility -- could this actually work given known constraints?
3. Alignment -- does this serve the stated topic, or is it tangential?

DO NOT filter for:
- Testability
- Technical correctness
- Completeness of specification

Encourage ambitious ideas. Weak verdicts should be rare -- reserve them for ideas that are off-topic or clearly infeasible.

For each idea, output a verdict (strong | fair | weak), a one-sentence rationale, and optional refinement suggestions.

Output format: JSON array of { index, verdict, rationale, suggestions? }.`;

export const CONVERGE_CLUSTER_GENERAL_SYSTEM = `You are grouping brainstorming ideas by affinity -- ideas that share a common thread, concern, or approach.

Group freely -- themes do not have to map to feature areas. A theme is "a shared thread" -- could be a technique, a domain, an audience, a trade-off.

For each cluster:
- A theme name (3-5 words, evocative)
- A 1-2 sentence theme description
- The list of idea indexes that belong

Every idea should belong to exactly one theme. Leave orphans in a "Miscellaneous" theme only if they genuinely don't fit.

Output format: JSON array of { name, description, ideaIndexes }.`;

export const CONVERGE_PROMOTE_GENERAL_SYSTEM = `You are selecting the most actionable ideas within each theme.

For each theme, pick 1-3 ideas that are:
- Most actionable (someone could start on Monday)
- Highest signal given the theme's shared thread
- A balance of ambitious and pragmatic (not all safe choices)

For each promoted idea, write a single concrete next-step sentence -- what the user would do first.

Output format: JSON array of { themeName, promotions: [{ ideaIndex, nextStep }] }.`;

export const ASSEMBLE_SUMMARY_SYSTEM = `You are writing a brainstorm summary document from themes and ideas.

The user's goal is a narrative recap + action items, NOT a formal specification with numbered requirements.

Write:
- A 3-5 sentence executive summary (what was explored, what emerged as the most promising direction)
- For each theme: a brief description, 2-4 key ideas in bullet form, and 1-3 concrete action items
- A "Recommended Next Steps" section listing the top 3 actions across all themes, in priority order
- Any open questions that emerged

Tone: conversational but direct. Avoid hedging. Use active voice.

Do NOT add idea IDs, requirement numbers, traceability tables, or any formal spec structure. This is a summary, not a spec.

Output ONLY the markdown summary document. No commentary, no wrapping fences.`;
