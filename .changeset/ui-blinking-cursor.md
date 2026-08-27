---
'@volund/ui': patch
---

Blink the input box cursor like a terminal: the `▌` caret now toggles every 500 ms while the box is focused, stays visible at the end of typed input (previously it vanished once text was entered), resets to visible on every keystroke, and pauses while the input is disabled so streaming frames are not redrawn for blink alone.
