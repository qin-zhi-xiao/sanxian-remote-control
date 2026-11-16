# 把 kuaichuan.ico 写进 exe 的图标资源（RT_ICON + RT_GROUP_ICON）
# 不依赖 rc.exe / 外部工具，直接调 Win32 UpdateResource。
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$Ico
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Exe)) { throw "找不到 exe: $Exe" }
if (-not (Test-Path $Ico)) { throw "找不到 ico: $Ico" }

$src = [System.IO.File]::ReadAllBytes($Ico)

# ---- 解析 ICO ----
# ICONDIR: reserved(2) type(2) count(2)
$count = [BitConverter]::ToUInt16($src, 4)
if ([BitConverter]::ToUInt16($src, 2) -ne 1) { throw "不是图标文件" }

$entries = @()
$offset = 6
for ($i = 0; $i -lt $count; $i++) {
    $w = [int]$src[$offset]
    $h = [int]$src[$offset + 1]
    $colors = [int]$src[$offset + 2]
    $reserved = [int]$src[$offset + 3]
    $planes = [BitConverter]::ToUInt16($src, $offset + 4)
    $bpp = [BitConverter]::ToUInt16($src, $offset + 6)
    $size = [BitConverter]::ToUInt32($src, $offset + 8)
    $imgOff = [BitConverter]::ToUInt32($src, $offset + 12)
    $entries += [pscustomobject]@{
        W = $w; H = $h; Colors = $colors; Reserved = $reserved
        Planes = $planes; Bpp = $bpp; Size = $size; Offset = $imgOff
    }
    $offset += 16
}

# ---- P/Invoke ----
if (-not ('KCRes' -as [type])) {
    Add-Type -Namespace '' -Name 'KCRes' -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);

[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
'@
}

$h = [KCRes]::BeginUpdateResource($Exe, $false)
if ($h -eq [IntPtr]::Zero) { throw "BeginUpdateResource 失败: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)" }

try {
    $RT_ICON = [IntPtr]3
    $RT_GROUP_ICON = [IntPtr]14
    $LANG = 0x0409

    # 每个图层作为 RT_ICON，资源 ID 从 1 开始
    for ($i = 0; $i -lt $entries.Count; $i++) {
        $e = $entries[$i]
        $sz = [int]$e.Size
        $img = New-Object byte[] $sz
        [Array]::Copy($src, [int]$e.Offset, $img, 0, $sz)
        $ok = [KCRes]::UpdateResource($h, $RT_ICON, [IntPtr]($i + 1), $LANG, $img, [uint32]$img.Length)
        if (-not $ok) { throw "写 RT_ICON $($i+1) 失败" }
    }

    # GRPICONDIR 里 Size 换成图标 ID
    $grp = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($grp)
    $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$entries.Count)
    for ($i = 0; $i -lt $entries.Count; $i++) {
        $e = $entries[$i]
        $bw.Write([byte]$e.W); $bw.Write([byte]$e.H)
        $bw.Write([byte]$e.Colors); $bw.Write([byte]$e.Reserved)
        $bw.Write([uint16]$e.Planes); $bw.Write([uint16]$e.Bpp)
        $bw.Write([uint32]$e.Size)
        $bw.Write([uint16]($i + 1))
    }
    $bw.Flush()
    $grpBytes = $grp.ToArray()
    $bw.Dispose()

    $ok = [KCRes]::UpdateResource($h, $RT_GROUP_ICON, [IntPtr]1, $LANG, $grpBytes, [uint32]$grpBytes.Length)
    if (-not $ok) { throw "写 RT_GROUP_ICON 失败" }
}
finally {
    [void][KCRes]::EndUpdateResource($h, $false)
}

Write-Output "已写入图标：$Exe（$count 个尺寸）"
