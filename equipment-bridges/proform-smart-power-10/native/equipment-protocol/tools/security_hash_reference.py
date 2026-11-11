import sys

MASK32 = 0xFFFFFFFF

# Independent oracle for the 32-byte security mix.
# STRIDE's published description uses unsigned 32-bit shifts. This transcription
# uses Int32 arithmetic right-shift on the part operand and its 16-bit rotate,
# which is the locally observed Legacy-helper compatibility requirement.
CASES = [
    (0x00000000, 0x00000000, 0x00000000),
    (0xFFFFFFFF, 0x12345678, 0x00000000),
    (0x0F0F1234, 374677, 39915),
    (123456789, 401234, 40111),
    (0x80000001, 0xDEADBEEF, 0x7FFFFFFF),
    (0x80000000, 0x80000000, 0x00000000),
    (0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF),
    (0x0000FFFF, 0x80000000, 0x00000000),
    (0xFFFF0000, 0x80000000, 0x00000000),
    (0x00000001, 0x7FFFFFFF, 0x80000000),
]


def i32(value):
    value = int(value) & MASK32
    if value >= 0x80000000:
        return value - 0x100000000
    return value


def shr32(value, bits):
    value = i32(value)
    if bits <= 0:
        return value
    if bits >= 32:
        return -1 if value < 0 else 0
    return i32(value >> bits)


def security_hash(serial, part, model):
    serial = i32(serial)
    part = i32(part)
    model = i32(model)
    rotated = i32(((part << 16) & MASK32) | (shr32(part, 16) & MASK32))
    out = []
    for bit in range(32):
        value = (bit + 1) & 0xFF
        if (serial >> bit) & 1:
            source = shr32(rotated, bit) if bit < 16 else shr32(part, bit)
            value ^= source & 0xFF
        else:
            value ^= (value * i32(bit + model)) & 0xFF
        out.append(value & 0xFF)
    return bytes(out)


def main():
    for serial, part, model in CASES:
        digest = security_hash(serial, part, model)
        sys.stdout.write("serial=0x%08X part=0x%08X model=0x%08X hash=%s\n" % (serial & MASK32, part & MASK32, model & MASK32, digest.hex().upper()))


if __name__ == "__main__":
    main()
