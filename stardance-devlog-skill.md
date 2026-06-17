---
name: stardance-devlog
description: Write Hack Club Stardance devlog entries and intro posts that build in public with an honest, human, build-in-public voice. Use this skill whenever the user wants to write, draft, update, or append a Stardance devlog, a build-in-public progress update, a project intro post for Stardance, or a milestone writeup for any technical project (software, hardware, robotics, AI). Trigger this even if the user just says "write a devlog," "update my Stardance," "log this milestone," or "add an entry" — assume Stardance format and this voice unless told otherwise.
---

# Stardance Devlog

A skill for writing Hack Club Stardance devlogs and intro posts in a consistent, honest, human, build-in-public voice. Works for any technical project. The structure and voice are the point, the subject is swappable.

## What Stardance is (context that shapes the writing)

Stardance is a Hack Club summer program (≈June–September) where teens build any technical project, log their *hours*, and earn prizes. It rewards **documented building over time**, not polished final products. There is a hardware track alongside software. This means:
- The audience rewards **honesty and process**, not marketing gloss.
- **Failures, walls, and pivots are assets**, not things to hide. They're proof of real building.
- Hours/effort are logged, so milestone-by-milestone progress maps naturally onto the format.

## The voice (non-negotiable — this is the skill's core)

Write like a real person telling a friend what they built this week. Specifically:

- **Sound human, with actual emotion.** Let the feeling show: the relief when a bug finally dies, the annoyance at the wall, the small pride when a number comes out right. A devlog should read like a person wrote it at 1am, not like a changelog. Say "this one nearly broke me" or "I genuinely grinned when it worked." Real feeling beats polish.
- **Honest about failures, to the point of vulnerability.** The best entries lead with what broke. "Here's where it nearly died" beats "here's what I achieved."
- **Plain language, almost no jargon.** Explain the hard thing the way you'd explain it out loud to a smart friend who doesn't know your stack. If a technical term isn't load-bearing, cut it. If it is load-bearing, explain it in plain words right after. Never let acronyms or framework names do the talking for you. The reader should feel what you built, not have to decode it.
- **Numbers as proof, always.** Every milestone ends with one concrete result: a count, a time, a visible output. Never "it works" with nothing behind it. But say the number like a person ("20 tests, all green") not like a spec sheet.
- **The novelty stated plainly.** What makes this different from the obvious version? One sharp, human sentence.
- **Lessons you can steal.** When something goes wrong, name the takeaway in a sentence the reader can lift for their own project.

## Hard formatting rules

- **NEVER use em dashes.** Use commas, parentheses, periods, or restructure. (Standing rule for this author.)
- **Keep it short.** A milestone is 1–3 short paragraphs. An intro post is short too. If it reads like a report, it's too long. Cut until only the real stuff is left: the feeling, the wall, the number, the point.
- **Concise does not mean thin.** Keep the good details (the specific bug, the actual number, the real reason something broke). Cut the padding, the throat-clearing, the restated obvious. Detail-dense and short at the same time is the target.
- Bold sparingly, for the one or two phrases that carry the entry.
- Short milestone headers (e.g. "M6 — live, end to end").
- If the platform has a character or hours field, size the entry to it.

## Structure

### Intro post (once per project)
Keep the whole thing short. Hit these beats in a few tight sentences each, not sections:
1. **The hook** — the one-sentence "what makes this different." Lead with the distinction, and make it feel like *you* saying it. (e.g. "I want to direct a drone with my hands. Not fly it. Direct it.")
2. **Why the obvious version is wrong** — name what everyone else builds, and why this isn't that.
3. **What you're building on** — prior work or existing system, framed as a strength.
4. **The plan and the one big idea** — the phased plan in a sentence, plus the key design choice that makes it work. Brief.

### Running log (per milestone)
Each milestone, kept to 1–3 short paragraphs:
1. **Bold lead** naming what the milestone was, in plain words.
2. **What happened, honestly** — including the wall if there was one, and how it felt.
3. **The number or visible output** that proves it.
4. **Optional one-line lesson**, if it taught something worth stealing.

### Pivot entries (when a plan changes)
Write it as a short story with a lesson, not an apology:
1. **What the wall was** — specific and candid (the real cause: a law, a cost, a physics limit, a dead dependency).
2. **The lesson, written to be stolen** — one sentence.
3. **Why the new direction is actually better** — honestly, not as a consolation prize.
4. **What survived** — the core/novelty is intact.

## Process for using this skill

1. **Gather the milestone facts.** Pull from the user's notes/results: the numbers, what broke, what was built, what's deferred. Ask for dev notes if not provided. Never invent numbers.
2. **Confirm scope:** new intro post, appended milestone(s), or a pivot writeup? Append to existing or standalone?
3. **Confirm candor level on any sensitive cause** (naming a specific law, company, or cost). Default to honest and specific unless the user wants it softened.
4. **Draft in the voice above**, short and human, sized to any known character/hours limit.
5. **Self-check before delivering** (see checklist).
6. **Offer to add** video/output links and an hours note if the platform wants them.

## Anti-patterns (do NOT do these)

- **Sounding like a robot or a changelog.** No flat "implemented X, added Y, fixed Z" lists. A person felt something building this. Show it.
- **Jargon as a crutch.** Don't hide behind stack names and acronyms. If your mum couldn't follow the gist, rewrite it.
- **Marketing gloss / hype openings.** "I'm thrilled to announce…" is wrong. Lead with substance or the wall.
- **"It works" with no number.** Every success needs a real measurement.
- **Hiding the failure.** The wall IS the content.
- **Inventing metrics.** If a number isn't in the notes, ask. Honesty is the whole brand.
- **Em dashes.** Never.
- **Length.** Long entries that read as reports. Tight and human beats thorough.
- **Pivots framed as defeats.** A pivot is a lesson plus a real upgrade.

## Self-check before delivering

- [ ] Does it sound like a human with feelings wrote it, not a changelog?
- [ ] Is the jargon stripped down, with anything technical explained in plain words?
- [ ] Is it genuinely short (1–3 short paragraphs per milestone, brief intro)?
- [ ] Did the good details survive the cutting (specific bug, real number, real cause)?
- [ ] Does each milestone end with a real number or visible output from the actual notes?
- [ ] Is the honest wall/failure present and prominent where there was one?
- [ ] Zero em dashes?
- [ ] Is the novelty stated in one sharp, human line?
- [ ] No invented facts or numbers?
- [ ] Sized to any character/hours constraint mentioned?
