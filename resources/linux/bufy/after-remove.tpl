#!/bin/bash

# Bufy: upstream's script runs on upgrades too and passes the link instead of the target to `--remove`.
# On rpm the old package's postun runs after the new postinst, so it deleted the fresh AppArmor profile on every
# upgrade. Only clean up on a real removal: rpm passes 0, deb passes remove/purge.
case "$1" in
    0|remove|purge) ;;
    *) exit 0 ;;
esac

for LINK in '${executable}' mattermost-desktop; do
    if type update-alternatives >/dev/null 2>&1; then
        update-alternatives --remove "$LINK" '/opt/${sanitizedProductName}/${executable}' >/dev/null 2>&1 || true
    fi
    if [ -L "/usr/bin/$LINK" ] && [ ! -e "/usr/bin/$LINK" ]; then
        rm -f "/usr/bin/$LINK"
    fi
done

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  rm -f "$APPARMOR_PROFILE_DEST"
fi
