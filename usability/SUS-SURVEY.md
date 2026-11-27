# Usability survey (SUS) for the parking website

A short, well-known questionnaire, the **System Usability Scale** (John Brooke, 1986), that turns "is it easy to use?" into one number from 0 to 100. Ask people who have never used the site to do six small jobs on it, then to answer ten statements. The script `scripts/sus-score.js` (run it with `npm run sus`) does the sums.

This kit is for testing the site. It is not part of the website and nothing in it is shown to drivers.

---

## 1. Before you start

- **Who:** aim for **10 or more** people who have not seen the site before (classmates, family, hostel mates, staff at a real lot). Include people who park a two-wheeler and people who park a car. Five people are enough to find most things that confuse users, but a SUS score from fewer than about ten people is only a rough guide; the 95% interval the script prints tells you how rough.
- **Where:** a copy of the site where **no real money is taken**: on your own computer (`npm start`, simulated payment) or the demo with Razorpay in test mode. Tell people the payment is a test.
- **On what:** let each person use **their own phone** if they can. Most drivers will.
- **Do not help.** Sit beside them, say nothing, and write down where they hesitate, go back or ask "what do I press?". Help only if they are stuck for more than two minutes, and note that you helped.
- **Personal details:** write a participant number (P01, P02 ...) and nothing else that identifies a person. No names, phone numbers or vehicle numbers on the sheet. Tell people they can stop at any time and that you are testing the site, not them. Use a made-up vehicle number for the booking (for example `MP09AB1234`).

## 2. The six jobs

Read each job out loud, one at a time. Do not use the names of the buttons.

| # | Job to give | Done when | Done? (yes / yes with help / no) | Seconds | What you saw |
|---|---|---|---|---|---|
| 1 | "You want to park your car tomorrow at 4 pm for two hours. Book a bay." | A bay is held and the payment step opens | | | |
| 2 | "Pay for it." | The booking shows as paid with a pass | | | |
| 3 | "You close the page. Later, find your booking again." | They find it by vehicle number (or from their account) | | | |
| 4 | "You are at the gate. Show what the attendant will scan." | The entry QR is on screen | | | |
| 5 | "You will stay one hour longer than you planned. Do something about it." | They extend, or book the next slot, and say what happens | | | |
| 6 | "Your plans changed. Cancel the booking." | They reach cancel and understand what they get back | | | |

Write down for every job: did they finish alone, finish with help, or give up; roughly how long it took; and any words they said out loud ("where is it?", "ah, there"). These notes are the most useful part: a score says *how much* trouble there is, the notes say *where*.

## 3. The ten statements (give this page to the participant)

Participant number: ______  I am using: phone / laptop / other: ______  I drive a: car / two-wheeler / neither

For each statement, circle **one** number: **1** = strongly disagree, **5** = strongly agree. Answer all ten, and give your first reaction rather than thinking long about it.

| | Statement | Strongly disagree | | | | Strongly agree |
|---|---|:-:|:-:|:-:|:-:|:-:|
| 1 | I think that I would like to use this website frequently. | 1 | 2 | 3 | 4 | 5 |
| 2 | I found the website unnecessarily complex. | 1 | 2 | 3 | 4 | 5 |
| 3 | I thought the website was easy to use. | 1 | 2 | 3 | 4 | 5 |
| 4 | I think that I would need the support of a technical person to be able to use this website. | 1 | 2 | 3 | 4 | 5 |
| 5 | I found the various functions in this website were well integrated. | 1 | 2 | 3 | 4 | 5 |
| 6 | I thought there was too much inconsistency in this website. | 1 | 2 | 3 | 4 | 5 |
| 7 | I would imagine that most people would learn to use this website very quickly. | 1 | 2 | 3 | 4 | 5 |
| 8 | I found the website very cumbersome to use. | 1 | 2 | 3 | 4 | 5 |
| 9 | I felt very confident using the website. | 1 | 2 | 3 | 4 | 5 |
| 10 | I needed to learn a lot of things before I could get going with this website. | 1 | 2 | 3 | 4 | 5 |

Two last questions (optional, in your own words):

- What was the **most confusing** part?
- What did you **like** most?

*(The statements are the standard SUS wording with "system" changed to "website", which is the usual adaptation. Do not reorder them and do not drop any: odd and even statements are worded in opposite directions on purpose.)*

## 4. Putting the answers into the computer

1. Copy `usability/responses-template.csv` to `usability/responses.csv`.
2. Add one line per participant: their number, who they are, then the ten circled numbers in order (q1 to q10). Put any comment in the last column (in double quotes if it has a comma).
3. Run:

   ```
   npm run sus                                  # reads usability/responses.csv
   npm run sus -- path/to/other-file.csv
   npm run sus -- usability/responses.csv --json   # the same numbers as JSON
   ```

The script refuses to guess: a missing answer, a number outside 1 to 5 or a repeated participant number is reported with its line number and nothing is scored until it is fixed.

## 5. How the score is worked out

For each person:

- statements **1, 3, 5, 7, 9** (worded positively): score = answer − 1
- statements **2, 4, 6, 8, 10** (worded negatively): score = 5 − answer
- add the ten scores (0 to 40) and multiply by **2.5**, giving 0 to 100

This is **not a percentage**. Across many studies of many kinds of software the average SUS score is about **68**, so:

| Score | Rule of thumb (Sauro and Lewis) |
|---|---|
| below about 51 | poor: users are struggling |
| about 51 to 68 | below average to average: usable, with clear problems |
| about 68 to 80 | above average to good |
| above about 80 | excellent: among the best tenth of products measured |

The script also prints the **average, middle value, spread (standard deviation) and a 95% interval** for the group, and the average of each statement after the 0 to 4 adjustment, so you can see *which* statement pulled the score down (a statement far below the others points at one part of the site; read your notes from that job).

## 6. Reporting it honestly

- Say how many people took part, who they were, and on what device.
- Give the average **with its 95% interval**, not only the average.
- Do not call a score "good" without saying what it is compared with (the 68 average above is the usual comparison).
- Report the jobs people could not finish and what you saw, and what you changed afterwards. Run it again after the changes: the point of a usability test is the improvement between two rounds.
- A group of friends is more forgiving than strangers. Say so if that is who you asked.
