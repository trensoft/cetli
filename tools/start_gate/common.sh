# SPDX-License-Identifier: GPL-3.0-or-later
# Shared by build.sh and check.sh (sourced, runs as root in a container of the image under test).

# dnf with no questions asked
gate_dnf() { dnf -y "$@"; }

# The repositories of the image under test. On EL10 the image is CentOS Stream 10 and the gate adds
# EPEL 10 and CRB, the way the COPR chroot epel-10 has them (the packages the build and the RPM need
# are in BaseOS and AppStream; the two are there so that the gate sees what the COPR build sees).
gate_repos() {
    . /etc/os-release
    echo "gate: image is ${PRETTY_NAME:-unknown}"
    case " ${ID_LIKE:-} ${ID:-} " in
    *" rhel "* | *" centos "*)
        gate_dnf install dnf-plugins-core
        gate_dnf config-manager --set-enabled crb
        gate_dnf install epel-release
        ;;
    esac
}
