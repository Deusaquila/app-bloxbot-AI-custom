param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path $env:USERPROFILE '.config\bloxbot\roblox-open-cloud-api-key'
$existing = Get-Item -LiteralPath $credentialPath -ErrorAction SilentlyContinue
if ($existing -and $existing.Length -gt 0) {
    Write-Host 'Credential file exists and is non-empty. It was not read or replaced.'
    exit 0
}
if ($VerifyOnly) { Write-Host 'Credential file is missing or empty.'; exit 1 }
$secret = $null
$pointer = [IntPtr]::Zero
$plain = $null
$stage = 'hidden input'
try {
    Write-Host 'BloxBot Open Cloud setup. Enter the API key only in this hidden prompt.'
    $secret = Read-Host 'Roblox Open Cloud API key' -AsSecureString
    if ($secret.Length -eq 0) { throw 'Empty input' }
    $stage = 'input conversion'
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
    if (!$plain -or $plain -match '[\r\n\x00]') { throw 'Invalid input' }
    $stage = 'external directory creation'
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($credentialPath)) | Out-Null
    if (!(Test-Path -LiteralPath $credentialPath)) { [IO.File]::WriteAllBytes($credentialPath, [byte[]]@()) }
    $stage = 'private file permissions'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($identity)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $credentialPath -AclObject $acl
    $stage = 'credential file save'
    [IO.File]::WriteAllText($credentialPath, $plain, (New-Object Text.UTF8Encoding($false)))
    if ((Get-Item -LiteralPath $credentialPath).Length -le 0) { throw 'Write failed' }
    Write-Host 'Credential saved outside the repository. Contents were not displayed.'
} catch {
    Write-Host ('Credential setup failed during: ' + $stage + '. No credential contents will be displayed.')
    exit 1
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $plain = $null
    if ($secret) { $secret.Dispose() }
}
