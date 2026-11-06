# Step 1 of mojibake recovery (see README.md).
# Corrupted page text -> original UTF-8 bytes, with holes marked as 00 00 pairs.
# Rule: a '?' immediately preceded by a non-ASCII char = the CP936 decoder ate
#       (one UTF-8 continuation byte + one ASCII byte < 0x40), so record a hole.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..\..')

$gbkEnc = [Text.Encoding]::GetEncoding(936,
    (New-Object Text.EncoderExceptionFallback),
    (New-Object Text.DecoderExceptionFallback))

# PUA char -> original byte pair (CP936 maps unmapped pairs into U+E000..U+F8FF)
$pua = @{}
for ($lead = 0x81; $lead -le 0xFE; $lead++) {
  for ($trail = 0x40; $trail -le 0xFE; $trail++) {
    if ($trail -eq 0x7F) { continue }
    try {
      $c = $gbkEnc.GetString([byte[]]@($lead, $trail))
      if ($c.Length -eq 1) { $cp = [int][char]$c; if ($cp -ge 0xE000 -and $cp -le 0xF8FF) { $pua[$cp] = [byte[]]@($lead, $trail) } }
    } catch {}
  }
}

foreach ($f in @('components.html', 'flow.html', 'mockups.html', 'story.html')) {
  $s = [IO.File]::ReadAllText((Join-Path $root $f), [Text.Encoding]::UTF8)
  $ms = New-Object System.IO.MemoryStream
  $chars = $s.ToCharArray()
  for ($i = 0; $i -lt $chars.Length; $i++) {
    $cp = [int]$chars[$i]
    if ($cp -lt 0x80) {
      if ($cp -eq 0x3F -and $i -gt 0 -and [int]$chars[$i-1] -ge 0x80) { $ms.WriteByte(0x00); $ms.WriteByte(0x00) }
      else { $ms.WriteByte([byte]$cp) }
      continue
    }
    if ($cp -eq 0x20AC) { $ms.WriteByte(0x80); continue }
    if ($pua.ContainsKey($cp)) { $b = $pua[$cp]; $ms.Write($b, 0, 2); continue }
    try { $b = $gbkEnc.GetBytes([string]$chars[$i]) } catch { $b = $null }
    if ($b) { $ms.Write($b, 0, $b.Length) } else { $ms.WriteByte(0x00); $ms.WriteByte(0x00) }
  }
  [IO.File]::WriteAllBytes((Join-Path $here "_rec_$f.bin"), $ms.ToArray())
  Write-Output "$f -> bin $($ms.Length) bytes"
}
