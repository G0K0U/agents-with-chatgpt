; Build only through tools/build_installer.py from a verified portable package.
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef PackageDir
  #error PackageDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif

[Setup]
AppId={{5DB55C75-258E-4C48-B760-224B0DA25184}
AppName=Quanta
AppVersion={#AppVersion}
AppPublisher=Quanta contributors
AppPublisherURL=https://github.com/SparklingAstronaut/quanta
AppSupportURL=https://github.com/SparklingAstronaut/quanta/issues
DefaultDirName={localappdata}\Programs\Quanta
DisableDirPage=no
DefaultGroupName=Quanta
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=Quanta-{#AppVersion}-Windows-x64-Setup
SetupIconFile=..\..\assets\icon.ico
UninstallDisplayIcon={app}\Quanta.exe
UninstallDisplayName=Quanta
WizardStyle=modern dynamic
Compression=lzma2
SolidCompression=yes
AppMutex=Local\aibar_tray_singleton
CloseApplications=yes
CloseApplicationsFilter=Quanta.exe
RestartApplications=no
SetupLogging=yes
VersionInfoVersion={#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[CustomMessages]
english.DesktopShortcut=Create a desktop shortcut
chinesesimplified.DesktopShortcut=创建桌面快捷方式
english.LaunchQuanta=Open Quanta
chinesesimplified.LaunchQuanta=打开 Quanta

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopShortcut}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#PackageDir}\*"; DestDir: "{app}"; Excludes: "Verify.cmd,SHA256SUMS"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "InnoSetup-LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Quanta"; Filename: "{app}\Quanta.exe"; WorkingDir: "{app}"; IconFilename: "{app}\Quanta.exe"
Name: "{autodesktop}\Quanta"; Filename: "{app}\Quanta.exe"; WorkingDir: "{app}"; IconFilename: "{app}\Quanta.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Quanta.exe"; Description: "{cm:LaunchQuanta}"; Flags: nowait postinstall skipifsilent

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';

procedure CurStepChanged(CurStep: TSetupStep);
var
  Existing: String;
begin
  { Preserve an existing Quanta startup choice when moving from a portable copy.
    A fresh install does not turn on startup. }
  if CurStep = ssPostInstall then
    if RegQueryStringValue(HKCU, RunKey, 'Quanta', Existing) then
      if CompareText(ExtractFileName(RemoveQuotes(Existing)), 'Quanta.exe') = 0 then
        RegWriteStringValue(HKCU, RunKey, 'Quanta', '"' + ExpandConstant('{app}\Quanta.exe') + '"');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Existing: String;
begin
  { Remove only the startup entry that points to this installation.
    Personal configuration and Credential Manager entries are never touched. }
  if CurUninstallStep = usPostUninstall then
    if RegQueryStringValue(HKCU, RunKey, 'Quanta', Existing) then
      if CompareText(RemoveQuotes(Existing), ExpandConstant('{app}\Quanta.exe')) = 0 then
        RegDeleteValue(HKCU, RunKey, 'Quanta');
end;
