# Pop-ups, banners and dialogs

A guide to the things a site puts in front of your test — newsletter forms,
cookie-consent banners, chat bubbles, and the browser's own alert boxes — and
to the two features that deal with them: the **Handle next dialog** step, and
the **Handle pop-ups** run option.

They are not interchangeable, and the commonest way to lose an afternoon here
is to reach for the one that sounds right. §1 is the sorting question; the rest
of the guide follows from its answer.

**This file is also part of the app's manual.** Settings → Documentation renders
it, and the Help menu opens it at a section, so it is written to be read on
screen.

---

## 1. Which kind of pop-up is it

Two different things get called a pop-up, and the app handles them with two
different features.

| What you see | What it is | What handles it |
| --- | --- | --- |
| A small plain box drawn by the browser itself — "This page says…", OK and Cancel, sometimes a text field — that freezes the page until you answer | A **browser dialog**: `alert`, `confirm`, `prompt`, or the "leave this page?" prompt | The **Handle next dialog** step (§2) |
| A panel, modal or banner drawn *inside* the page — a newsletter form, a cookie-consent bar, a chat bubble, an app-install interstitial | A **page overlay**: ordinary page content, usually injected by a third-party script such as Klaviyo or DataGrail | **Handle pop-ups** (§3), with the built-in handlers (§4) and the rules you teach (§5) |

The distinction matters because the browser only knows about the first kind. A
dialog is an event the browser raises and the test can answer. An overlay is
just more page: to the browser it is no different from the site's own header,
and nothing about it is announced.

**Why Handle next dialog cannot touch a newsletter form or a consent banner.**
The step tells the browser how to answer the next dialog it raises. A Klaviyo
form or a DataGrail banner never raises one — it is drawn by a script, not by
the browser — so the answer stays armed, waiting for a dialog that never comes,
and nothing on the page is touched. The run does not fail at that step. It fails
later, at whatever the overlay is covering.

**Why wrapping it in an if-block does not help.** An `if` reads its condition
once, at the instant the run reaches it, and moves on. A pop-up on a timer is
almost never there yet at that instant — on ritual.com, the site the app was
built against, the newsletter form arrives about eight seconds into a visit —
so the block is skipped. And when the timing does line up, all the block does
is arm a dialog answer, which is the same nothing as before.

**Why Continue on Failure has nothing to catch.** It lets the run carry on past
a step that raises an error. Arming a dialog answer never raises one, so there
is no failure to continue from; the step succeeds at doing nothing.

**Why even a correct click is only right until the next navigation.** Suppose
you record the click on the banner's Close control as an ordinary step. It
works — and the banner is back on the next page, because a consent script
re-injects it into every document it loads. Measured on ritual.com: click Close,
the banner goes; navigate, it returns. Recording the consent decision instead
did not suppress it, and neither did carrying the cookies over from a browser
that had already dismissed it. Playwright also starts every test in a fresh
browser, so every test would need its own click. There is no place in a step
list to write "whenever this appears" — which is why the answer is a standing
behaviour rather than a step.

---

## 2. Browser dialogs and the Handle next dialog step

For the first kind. **Add step → Handle next dialog** arms a one-shot answer for
the next `alert`, `confirm` or `prompt` the page raises: **Accept** (OK, with
optional text for a prompt) or **Dismiss** (Cancel).

Three things worth knowing.

- **It answers the *next* dialog only.** Place it immediately before the step
  that triggers the dialog. Two dialogs need two steps.
- **Without one, a run dismisses every dialog on its own.** So a test that
  never adds the step still runs; the step exists for the cases where Cancel is
  the wrong answer, or where the prompt needs text.
- **If the box you are looking at does not go away, it was not a dialog.** The
  browser's dialogs are plain, unstyled and outside the page. Anything drawn in
  the site's own fonts and colours is an overlay, and §3 is where to go.

---

## 3. Handle pop-ups

The run option for page overlays. When it is on, every page the run visits is
watched, and anything a rule or a built-in handler matches is clicked away the
moment it appears — on the first page and on every page a later navigation
produces. When it is off, nothing is clicked away: not the built-in handlers,
and not the rules you taught for the site either.

**Where it is.** Two places, at two scopes.

- **On the test**, in the run options beside *Capture screenshots*: the *Handle
  pop-ups* box. It is what this test does, on every run, from the app or from
  the command line.
- **In Settings → Overlay rules**, the *Handle pop-ups* switch is the default a
  test starts from. It is on out of the box, so a test you never touched behaves
  the way the app always has. A test's own box, once you change it, wins over
  the default.

**It applies while recording, too.** The New Recording dialog has a *Handle
pop-ups while recording* box, ticked to match your default. Leave it ticked and
the trainer clicks overlays away as you record, exactly as a run will. Untick
it and the new test starts with Handle pop-ups off, so the recording and its
runs agree. Opening an existing test in the trainer follows the test's own
setting, and changing the switch or a built-in handler in Settings re-arms a
recording that is already open.

**Off is for a test whose subject is the pop-up.** A test that checks the
newsletter form appears, or that the consent banner's Reject button does what it
says, needs the overlay left alone. Turn the box off on that test and nothing
else changes — every other test keeps the default. §8 covers this in more
detail.

**Imported tests are the exception**, as they are for every run-time feature: a
spec imported from someone else's Playwright project runs as written, and
nothing is clicked away in it.

---

## 4. Built-in handlers

Two overlays are handled with nothing to teach, because they are the ones the
app was built and measured against. Each is a rule the app ships rather than one
you taught, and each clicks the vendor's own close control — never anything
that makes a choice on your behalf.

| Handler | What it clicks | What it never does |
| --- | --- | --- |
| **Klaviyo form — Close** | The close control on a Klaviyo pop-up or flyout sign-up form (the X, usually named "Close dialog") | Fill in or submit the form |
| **DataGrail consent banner — Close** | The banner's Close control (the X in its header) | Press Accept, Reject or Manage — a consent decision is yours to record, not the app's to make |

**They match only the vendor's own markup.** Each looks for its close control
inside the container that vendor's script renders, so a site that does not use
Klaviyo or DataGrail costs nothing and a site's own dialogs are never touched. A
"Close" button anywhere else on the page is left alone.

**Each can be switched off** in Settings → Overlay rules, under *Built-in
handlers*. Switching one off applies to every test on this Mac; to keep the
overlay for one test, turn that test's *Handle pop-ups* off instead (§3).

**They are switchable and they are not editable.** If a site has changed its
markup so a handler no longer matches, teach a rule for that site (§5) — that
is exactly the case rules exist for, and the run's output (§6) is how you find
out.

---

## 5. Teaching a rule for any other site

For an overlay the built-in handlers do not cover — a different consent tool, a
chat widget, a site's own promotional modal — you teach the app what to click,
once, while looking at it.

**In the trainer, wait for the overlay to appear, right-click the control that
closes it, and choose Always dismiss this overlay.** The rule is created at once,
named from the control's own text, and from then on the trainer and every run
of a test on that site click it away whenever it appears. It is not a step, and
it is not recorded into the test you are working on — which is the point.

**It has to be taught while the overlay is on screen.** The app refuses a rule
typed by hand, because a selector nobody saw match is a selector that may click
something nobody chose. That is a real limit for a pop-up on a timer or one
that only appears as the mouse leaves the window, and it is why the built-in
handlers exist: Klaviyo and DataGrail overlays arrive whether or not they showed
during your recording.

**Rules belong to a site, not to a test.** One rule covers every test that
visits that host, including `www.` and any subdomain — and never a lookalike
domain. Settings → Overlay rules lists them grouped by host. A rule can be
renamed, **disabled** (kept, but not armed — the right move while you work out
whether it is causing trouble) or **deleted**. Its target is not editable: to
point it at something else, teach a new one. A host can hold up to twenty.

**Rules live on this Mac.** They are not part of the test, they are not written
into the exported bundle a build server runs (§7), and a colleague running the
same test without the rule will see the overlay. Every run says in its output
which rules it armed, so that difference is visible rather than mysterious.

---

## 6. What a run tells you

A run that quietly clicks things on a page is a run whose failures point
nowhere, so every run says what it did.

**In the run output**, one system line near the top:

- `Handling pop-ups: Klaviyo form — Close, DataGrail consent banner — Close.` —
  what was armed for this run, by name. A rule you taught appears under its own
  name beside the built-ins.
- `Handle pop-ups is off for this test — 2 overlay rules for this site and the
  built-in handlers were not armed.` — the option is off, and there were rules
  for this site it would have used.
- `Handle pop-ups is off for this test — the built-in pop-up handlers were not
  armed.` — the option is off, and no rule exists for this site.

No line at all means there was nothing to arm: no rule for this site and the
built-in handlers switched off, or an imported test.

**From inside the run**, in the log, two lines from the watcher itself:

- `[glaze-dismiss] armed: Klaviyo form — Close, DataGrail consent banner —
  Close` — the same list, confirmed from inside the browser.
- `[glaze-dismiss] dismissed: DataGrail consent banner — Close (x2)` — what was
  actually clicked, with a count. A count above one is not a fault: it means
  the overlay came back, on a later page or after being re-injected, and was
  clicked away again. That is the case the whole feature exists for.

An armed line with no dismissed line means the overlay never appeared in this
run — which for a pop-up on a timer or on exit intent is ordinary.

**When a click was intercepted.** A run that fails with Playwright's
"intercepts pointer events" while Handle pop-ups is off adds one more line:
`A click was intercepted by another element and Handle pop-ups is off for this
test. If that element was a pop-up or banner, turn Handle pop-ups on in the run
options.` The trainer says the same thing live: replaying a step under an
overlay reports that another element is on top of the one the step wants, and
names it.

---

## 7. Runs outside the app

The command line, the GitHub Action and the MCP server run the same tests the
same way, and pop-up handling is no exception: each reads the test's own *Handle
pop-ups* option, with the same default underneath, and arms rules and built-in
handlers through the same code the app uses. A test that keeps its pop-up in the
app keeps it on a build server.

Two things do not travel, and it is worth knowing which.

- **The rules you taught stay on this Mac**, as do the Settings default and the
  built-in handler switches. An exported bundle carries each test's own *Handle
  pop-ups* choice and nothing else about pop-ups — so on a runner, what arms is
  the built-in handlers, unless the test turned the option off.
- **The MCP server reads your Mac's own rules**, since it runs on the same
  machine and reads the same folder. A run from an assistant arms exactly what
  an app run would.

Every unattended run reports what it armed, exactly as §6 describes. An MCP run
also names the exception in its `fixtures` field: when a test has the option
off and rules exist for its site, the note reads that Handle pop-ups is off for
this test, so its overlay rules and the built-in handlers were not armed, and a
step that acts on something a banner covers fails by the test's own choice. An
assistant asking `get_test` sees the option beside the test's other run
settings.

---

## 8. When you want the pop-up

Sometimes the overlay *is* the test: a check that the newsletter form appears,
an assertion on the consent banner's wording, a click on its Reject button.
With handling on, the watcher clicks the close control the instant the overlay
renders — usually before your assertion reads it — so the step fails or, worse,
flakes.

- **For one test:** turn off *Handle pop-ups* in that test's run options. While
  recording it, untick *Handle pop-ups while recording* in the New Recording
  dialog so the trainer leaves the overlay alone as well.
- **For one overlay, everywhere:** switch off its built-in handler in Settings →
  Overlay rules, or disable the rule you taught for that host. Every test on
  this Mac then sees that overlay.
- **For everything:** switch off the default in Settings → Overlay rules. Tests
  that set their own box keep their choice.

Turning it off changes nothing else about the run. The banner is on the page
because the site put it there; your test now sees the site as a visitor does.

---

## 9. Pop-up troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| I added Handle next dialog and the pop-up is still there | It is a page overlay, not a browser dialog — the step armed an answer nothing asked for | Delete the step. Check *Handle pop-ups* is on for the test (§3); for an overlay the built-ins do not cover, teach a rule (§5) |
| A click fails with "intercepts pointer events" | Something is drawn over the element. If the run also says Handle pop-ups is off, that something was probably a banner | Turn *Handle pop-ups* on in the run options. If it is already on, the overlay is one nothing matched — teach a rule for it |
| The run says it armed the handler, but the pop-up was not dismissed | The handler matched nothing on this page: the site's markup differs from what the built-in looks for, or the overlay is a different vendor's | Teach a rule for this site by right-clicking the overlay's close control in the trainer (§5). A taught rule runs beside the built-ins |
| The consent banner has no close button | Some sites configure the banner without one, so the DataGrail handler has nothing to click | Teach a rule on the control you want pressed — and note that the app's own handler will never press Accept or Reject for you |
| The pop-up appears only sometimes | It is on a timer or on exit intent, so it may not show during a short recording or an early step | Nothing to do. The watcher is armed for the whole page, not for one step, and clicks the overlay when it arrives. An armed line with no dismissed line in the log means it did not appear that run |
| My assertion on the banner fails or flakes | Handle pop-ups clicked it away before the assertion read it | Turn *Handle pop-ups* off for that test (§8) |
| The test passes here and fails on the build server | The rule you taught lives on this Mac; only the built-in handlers reached the runner | Expected — see §7. If the overlay is one the built-ins cover, check the test's option is on; otherwise it needs a rule, which does not travel |
| Nothing about pop-ups appears in the run output | There was nothing to arm: no rule for this host and the built-in handlers switched off — or an imported test | Check Settings → Overlay rules. Imported specs run as written, with no fixtures at all |
| A handler or rule clicked something it should not have | A rule's target matched more than the overlay, or a site reused a vendor's markup | Disable the rule (or the handler) in Settings → Overlay rules, run again, and teach a rule on a more specific control |

---

## 10. Links that open a new tab

A link with a new-tab target, or a button that calls `window.open`, is not a
pop-up in either sense above — it is a second browser tab — and nothing here
handles it, because nothing needs to. While you record, the trainer keeps every
navigation in its one window, so your recording is one linear journey: the
click, then the steps you took on the page it opened. When the test runs, the
browser opens that page in a new tab exactly as a visitor's would, and the run
follows it: every step after the click acts on the newest tab, and if that tab
closes itself (a sign-in window often does), the run continues on the tab it
came from.

There is nothing to switch on and nothing to add to the test. The one thing you
will see is a line in Step details while the run is being watched, under the
step that opened the tab, reading *New Tab Opened (#N)* — N being how many tabs
the run's browser had open at that moment — and the same line in the run's log.

A test imported from another Playwright project is the exception: it runs as
written, with its own handling of any tab it opens.

---

## Related reading

- **Settings → Overlay rules** — the default switch, the built-in handlers and
  every rule you have taught, grouped by host.
- The MCP guide's *What it can and cannot do*, in the topics beside this one —
  what an unattended run does with the test's settings, pop-ups included.
- The CI guide's *Why run tests outside the app* — the same question for the
  command line and the Action.
- [`docs/DECISIONS.md`](DECISIONS.md), entries for 2026-08-22 and 2026-09-01 —
  the measurements on ritual.com this guide summarises, and why the feature
  took this shape.
