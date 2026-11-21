"""Bufy fork: render tray silhouette masks (simplified planet-mining mark, 32 px grid) (mark / mark-with-badge-gap / badge) at 512 px via headless Chrome."""
import subprocess, sys, os
out = sys.argv[1]
MARK = '''
<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
  <rect width="32" height="32" fill="#000"/>
  <circle cx="16" cy="18.5" r="13" fill="#fff"/>
  <path d="M16 20 L2.5 6.5 A19 19 0 0 1 29.5 6.5 Z" fill="#000"/>
  <rect x="15" y="0" width="2" height="9" fill="#fff"/>
  <rect x="11" y="8" width="10" height="4" rx="1.2" fill="#fff"/>
  <path d="M14 11.5 L18 11.5 L16 14.5 Z" fill="#fff"/>
  {gap}
</mask>
<rect width="32" height="32" fill="#fff" mask="url(#m)"/>
'''
GAP = '<circle cx="25" cy="25" r="8.2" fill="#000"/>'
BADGE = '<circle cx="25" cy="25" r="6.2" fill="#fff"/>'
def svg(body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 32 32">{body}</svg>'
for name, body in [('mark', MARK.format(gap='')), ('markgap', MARK.format(gap=GAP)), ('badge', BADGE)]:
    p = os.path.join(out, name + '.svg')
    open(p, 'w').write(svg(body))
    subprocess.run(['timeout', '-k', '5', '60', 'google-chrome', '--headless=new', '--user-data-dir=' + os.path.join(out, 'chrome-prof'), '--hide-scrollbars', '--default-background-color=00000000',
                    f'--screenshot={os.path.join(out, name + "_512.png")}', '--window-size=512,512', 'file://' + p],
                   check=True, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)

# Vector sources for resources/windows/tray*.svg (black silhouette, red / blue badge), 32 px grid.
for name, body in [('tray', MARK.format(gap='')),
                   ('tray_mention', MARK.format(gap=GAP) + BADGE.replace('#fff', '#FF3B30')),
                   ('tray_unread', MARK.format(gap=GAP) + BADGE.replace('#fff', '#579EFF'))]:
    body = body.replace('<rect width="32" height="32" fill="#fff" mask', '<rect width="32" height="32" fill="#000" mask')
    open(os.path.join(out, name + '.svg'), 'w').write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">{body}</svg>\n')
