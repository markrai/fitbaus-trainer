using System;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Pure freshness query for external HR display. Store does not mutate itself.
    /// </summary>
    public static class HeartRateFreshness
    {
        public static readonly TimeSpan FreshWindow = TimeSpan.FromSeconds(3);

        public static bool IsFresh(HeartRateSnapshot snapshot, DateTime utcNow)
        {
            if (snapshot == null || !snapshot.Bpm.HasValue || !snapshot.ObservedAt.HasValue)
            {
                return false;
            }

            DateTime now = utcNow.Kind == DateTimeKind.Utc ? utcNow : utcNow.ToUniversalTime();
            DateTime observed = snapshot.ObservedAt.Value.Kind == DateTimeKind.Utc
                ? snapshot.ObservedAt.Value
                : snapshot.ObservedAt.Value.ToUniversalTime();

            if (observed > now)
            {
                return false;
            }

            return (now - observed) <= FreshWindow;
        }

        public static int? DisplayBpm(HeartRateSnapshot snapshot, DateTime utcNow)
        {
            return IsFresh(snapshot, utcNow) ? snapshot.Bpm : null;
        }
    }
}
