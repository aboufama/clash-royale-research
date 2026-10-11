"""Bounded decimal-to-binary64 libc model; integer rounding, no game mechanics.

Only complete finite decimal literals, signed zero or normal binary64 outputs,
and default FPCR are supported. This is a value-only runtime model, not
recovered Bionic. It does not reproduce floating-point status flags: original
Bionic sets FPSR for inputs such as 0.1, while this integer calculation does not.
"""

import re


def decimal_to_binary64(text):
    if not isinstance(text, bytes) or not 1 <= len(text) <= 128:
        raise ValueError("Unsupported decimal literal length")
    match = re.fullmatch(rb"([+-]?)([0-9]+)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?", text)
    if match is None:
        raise ValueError("Unsupported atof literal syntax")
    sign, whole, fraction, exponent = match.groups()
    fraction = fraction or b""
    exponent = int(exponent or 0) - len(fraction)
    if not -400 <= exponent <= 400:
        raise ValueError("Decimal exponent outside bounded domain")
    signbit = int(sign == b"-") << 63
    numerator, denominator = int(whole + fraction), 1
    if numerator == 0:
        return signbit
    if exponent < 0:
        denominator = 10**-exponent
    else:
        numerator *= 10**exponent
    power = numerator.bit_length() - denominator.bit_length()
    below_power = (
        (numerator < denominator << power)
        if power >= 0
        else (numerator << -power < denominator)
    )
    if below_power:
        power -= 1
    if not -1022 <= power <= 1023:
        raise ValueError("Subnormal or overflowing conversion requires original libc")
    shift = 52 - power
    if shift >= 0:
        numerator <<= shift
    else:
        denominator <<= -shift
    significand, remainder = divmod(numerator, denominator)
    # IEEE round to nearest, ties to even, directly from the exact decimal ratio.
    if 2 * remainder > denominator or (
        2 * remainder == denominator and significand & 1
    ):
        significand += 1
    if significand == 1 << 53:
        significand >>= 1
        power += 1
    if power > 1023:
        raise ValueError("Overflow requires original libc")
    assert 1 << 52 <= significand < 1 << 53
    return signbit | ((power + 1023) << 52) | (significand - (1 << 52))
