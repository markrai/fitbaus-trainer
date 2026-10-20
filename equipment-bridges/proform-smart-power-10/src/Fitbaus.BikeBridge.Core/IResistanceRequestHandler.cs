namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Immediate result of invoking the equipment resistance setter.
    /// Does not mean the machine has reached the requested level.
    /// </summary>
    public sealed class ResistanceRequestOutcome
    {
        private ResistanceRequestOutcome(bool accepted, int requested, string error)
        {
            Accepted = accepted;
            Requested = requested;
            Error = error;
        }

        public bool Accepted { get; private set; }

        public int Requested { get; private set; }

        public string Error { get; private set; }

        public static ResistanceRequestOutcome Ok(int requested)
        {
            return new ResistanceRequestOutcome(true, requested, null);
        }

        public static ResistanceRequestOutcome Fail(string error)
        {
            return new ResistanceRequestOutcome(false, 0, error ?? "resistance request failed");
        }
    }

    /// <summary>
    /// Application-level resistance request. Implementations must not write telemetry.
    /// </summary>
    public interface IResistanceRequestHandler
    {
        ResistanceRequestOutcome Request(int level);
    }
}
