' Starts the Trading Journal with no terminal window.
' To start it at login: press Win+R, type shell:startup, and put a shortcut to this file there.
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & folder & "\run.bat""", 0, False
