' pi-web-ui dev environment launcher (windowless).
'
' IMPORTANT: keep this file ASCII-only.
' Windows Script Host decodes .vbs as system ANSI (GBK on Chinese Windows) unless the
' file is UTF-16 with BOM. Non-ASCII characters here cause "unterminated string constant".
'
' What it does: runs start-pi-web-ui-dev.ps1 hidden in the background (so no black console
' window is left behind, same feel as the production "Start pi-web-ui" shortcut), waits for
' the dev UI to come up, and pops a message box only if it failed.

Option Explicit

Dim sh, fso, root, cmd, ok, i, req

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\start-pi-web-ui-dev.ps1"" -OpenBrowser"
' 0 = hidden window, False = do not wait for it (the script keeps running to watch page connections)
sh.Run cmd, 0, False

' Wait up to 60 seconds for the dev UI; exit silently on success, show a box on failure.
ok = False
For i = 1 To 30
    WScript.Sleep 2000
    On Error Resume Next
    Set req = CreateObject("WinHttp.WinHttpRequest.5.1")
    req.SetTimeouts 2000, 2000, 2000, 2000
    req.Open "GET", "http://localhost:5173/", False
    req.Send
    If Err.Number = 0 Then
        If req.Status >= 200 And req.Status < 500 Then ok = True
    End If
    Err.Clear
    On Error GoTo 0
    If ok Then Exit For
Next

If Not ok Then
    MsgBox "pi-web-ui dev environment failed to start." & vbCrLf & vbCrLf & _
           "To see the detailed error, double-click:" & vbCrLf & _
           root & "\run-pi-web-ui-dev.cmd" & vbCrLf & vbCrLf & _
           "(production instance on port 8787 is not affected)", 48, "pi-web-ui dev"
End If
