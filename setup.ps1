# One-time setup of the website secrets. Worker and database already exist.
# Secrets are typed hidden and go straight to Cloudflare and GitHub, they are never written to a file.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$site = "HerobrineTV/SpE-ItemDisplay-Releases"
$plugin = "HerobrineTV/SpE-Challenges"

# The token in the environment has too few permissions, this process uses the browser login instead
Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue

function Read-Secret($prompt) {
    $secure = Read-Host $prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Set-WorkerSecret($name, $value) {
    $value | npx --yes wrangler@4 secret put $name
    if ($LASTEXITCODE -ne 0) { throw "Could not set $name" }
}

function Set-GitHubSecret($name, $value, $repo) {
    $value | gh secret set $name --repo $repo
    if ($LASTEXITCODE -ne 0) { throw "Could not set $name" }
}

Set-Location "$root\worker"
if ((Get-Content "$root\site\config.js" -Raw) -notmatch "https://[a-z0-9.-]+\.workers\.dev") { throw "Worker URL not found in site/config.js" }
$api = $Matches[0]

Write-Host ""
Write-Host "Create an application at https://discord.com/developers/applications" -ForegroundColor Cyan
Write-Host "Under OAuth2 add this redirect URL:" -ForegroundColor Cyan
Write-Host "  $api/auth/callback" -ForegroundColor Yellow
Write-Host ""
Write-Host "Create a fine-grained GitHub token at https://github.com/settings/personal-access-tokens/new" -ForegroundColor Cyan
Write-Host "  Only repository: SpE-ItemDisplay-Releases, permission: Contents read and write" -ForegroundColor Cyan
Write-Host ""

$discordId = Read-Host "Discord Client ID"
$discordSecret = Read-Secret "Discord Client Secret"
$githubToken = Read-Secret "GitHub token"
$webhook = Read-Secret "Discord webhook URL"

$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$sessionSecret = [Convert]::ToBase64String($bytes)

Set-WorkerSecret "DISCORD_CLIENT_ID" $discordId
Set-WorkerSecret "DISCORD_CLIENT_SECRET" $discordSecret
Set-WorkerSecret "SESSION_SECRET" $sessionSecret
Set-WorkerSecret "GITHUB_DISPATCH_TOKEN" $githubToken

Set-GitHubSecret "DISCORD_WEBHOOK_URL" $webhook $site
Set-GitHubSecret "SITE_REPO_TOKEN" $githubToken $plugin

Write-Host ""
Write-Host "Done. Tell Claude that the setup is finished." -ForegroundColor Green
