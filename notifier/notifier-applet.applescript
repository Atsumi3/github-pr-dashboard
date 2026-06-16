-- Branded notification helper. osacompile turns this into "PR Dashboard.app"
-- so macOS attributes notifications to "PR Dashboard" instead of the node
-- binary (which otherwise shows as "Node.js Foundation"). notify.js writes a
-- payload file (line 1 = title, remaining lines = body) and launches this
-- applet via `open -a`, which delivers the file through `on open`.
on open theFiles
  set payloadFile to item 1 of theFiles
  set theText to read payloadFile as «class utf8»

  set theTitle to "PR Dashboard"
  set theBody to ""
  set AppleScript's text item delimiters to linefeed
  set theLines to text items of theText
  if (count of theLines) ≥ 1 then set theTitle to item 1 of theLines
  if (count of theLines) ≥ 2 then set theBody to (items 2 thru -1 of theLines) as text
  set AppleScript's text item delimiters to ""

  display notification theBody with title theTitle

  try
    do shell script "rm -f " & quoted form of (POSIX path of payloadFile)
  end try
end open
