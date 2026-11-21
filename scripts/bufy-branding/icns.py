"""Bufy fork: write a PNG-based .icns: icns.py out.icns <1024.png> (needs magick for resizing)."""
import struct, subprocess, sys, tempfile, os
out, src = sys.argv[1], sys.argv[2]
types = [('icp4', 16), ('icp5', 32), ('icp6', 64), ('ic07', 128), ('ic08', 256), ('ic09', 512), ('ic10', 1024),
         ('ic11', 32), ('ic12', 64), ('ic13', 256), ('ic14', 512)]
chunks = b''
with tempfile.TemporaryDirectory() as d:
    for t, px in types:
        p = os.path.join(d, f'{t}.png')
        subprocess.run(['magick', src, '-resize', f'{px}x{px}', '-strip', f'PNG32:{p}'], check=True)
        data = open(p, 'rb').read()
        chunks += t.encode() + struct.pack('>I', len(data) + 8) + data
open(out, 'wb').write(b'icns' + struct.pack('>I', len(chunks) + 8) + chunks)
