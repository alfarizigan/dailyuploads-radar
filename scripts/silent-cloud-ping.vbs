Option Explicit
Dim fso, scriptDir, repoDir, nodeExe, pingerJs, shell, cmd, rc
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoDir = fso.GetParentFolderName(scriptDir)

nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then
  nodeExe = "node"
End If

pingerJs = fso.BuildPath(repoDir, "src\cloud-pinger.js")
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = repoDir
cmd = """" & nodeExe & """ --no-warnings """ & pingerJs & """"
rc = shell.Run(cmd, 0, True)
WScript.Quit rc
