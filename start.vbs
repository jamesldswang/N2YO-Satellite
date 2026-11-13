' Start the server in the background (no console window) and open the page.
' Uses node.exe next to this file (release zip) if present, else node on PATH.
' If the server is already running, the new one exits (port in use) and the
' page still opens. To stop a background server, see README.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

node = "node"
If fso.FileExists(dir & "\node.exe") Then node = """" & dir & "\node.exe"""

' First run: create .env from the template and open it for the API key.
If Not fso.FileExists(dir & "\.env") And fso.FileExists(dir & "\.env.example") Then
  fso.CopyFile dir & "\.env.example", dir & "\.env"
  sh.Run "notepad """ & dir & "\.env""", 1, False
End If

sh.Run node & " """ & dir & "\server.js""", 0, False

' "start.vbs /background" (used by autostart.cmd at logon): server only, no browser.
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "/background" Then WScript.Quit
End If
WScript.Sleep 1000
sh.Run "http://localhost:8000"
