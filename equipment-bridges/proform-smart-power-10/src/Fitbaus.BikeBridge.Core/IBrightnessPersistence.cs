namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Durable last-accepted console brightness. Android SharedPreferences
    /// implements this; Core tests use an in-memory fake.
    /// </summary>
    public interface IBrightnessPersistence
    {
        bool TryLoad(out int percent);

        void Save(int percent);
    }
}
