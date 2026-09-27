' ai-quota-bar autostart (Windows): run the tray monitor hidden at logon.
' Generic version - derives the project folder from this script's own location,
' so it works for any user/path. Edit PYTHONW below if your Python lives elsewhere.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
PYTHONW = "C:\Python314\pythonw.exe"   ' <- EDIT: path to your pythonw.exe
If Not fso.FileExists(PYTHONW) Then
  PYTHONW = "pythonw.exe"              ' fallback: rely on PATH
End If

sh.CurrentDirectory = projectDir
sh.Run """" & PYTHONW & """ -m aibar.ui_windows", 0, False
