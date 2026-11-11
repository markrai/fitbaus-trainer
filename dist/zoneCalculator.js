// Map HR value to zone (1-5, with 6 mapped to 5)
export function mapHrToZone(hr) {
    if (hr <= 110)
        return 1;
    if (hr >= 115 && hr <= 130)
        return 2;
    if (hr >= 131 && hr <= 145)
        return 3;
    if (hr >= 155 && hr <= 162)
        return 4;
    if (hr >= 165 && hr <= 175)
        return 5;
    if (hr > 175)
        return 5;
    if (hr >= 111 && hr <= 114)
        return 2;
    if (hr >= 146 && hr <= 154)
        return 3;
    if (hr >= 163 && hr <= 164)
        return 4;
    return 1;
}
export function calculateZoneMinutes(hrSamples) {
    const zoneMinutes = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
    if (!hrSamples || hrSamples.length === 0)
        return zoneMinutes;
    const sorted = [...hrSamples].sort((a, b) => a.timestamp_sec - b.timestamp_sec);
    const zoneSeconds = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const sample of sorted) {
        if (sample.hr && sample.hr > 0) {
            const zone = mapHrToZone(sample.hr);
            zoneSeconds[zone] = (zoneSeconds[zone] || 0) + 1;
        }
    }
    zoneMinutes.z1 = Math.round(zoneSeconds[1] / 60);
    zoneMinutes.z2 = Math.round(zoneSeconds[2] / 60);
    zoneMinutes.z3 = Math.round(zoneSeconds[3] / 60);
    zoneMinutes.z4 = Math.round(zoneSeconds[4] / 60);
    zoneMinutes.z5 = Math.round(zoneSeconds[5] / 60);
    return zoneMinutes;
}
export function determinePrimaryZone(zoneMinutes) {
    let max = 0;
    let primary = 1;
    ["z5", "z4", "z3", "z2", "z1"].forEach((key) => {
        const val = zoneMinutes[key];
        if (val > max) {
            max = val;
            primary = parseInt(key.slice(1), 10);
        }
    });
    if (max === 0)
        return 1;
    return primary;
}
export function registerZoneGlobals() {
    window.mapHrToZone = mapHrToZone;
    window.calculateZoneMinutes = calculateZoneMinutes;
    window.determinePrimaryZone = determinePrimaryZone;
}
