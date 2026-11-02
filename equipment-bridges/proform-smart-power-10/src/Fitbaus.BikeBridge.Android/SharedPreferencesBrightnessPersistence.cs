using Android.Content;
using Fitbaus.BikeBridge.Core;

namespace Fitbaus.BikeBridge.AndroidApp
{
    /// <summary>
    /// Last accepted console brightness in private SharedPreferences.
    /// Survives Activity recreation and process restart. API 22-safe.
    /// </summary>
    public sealed class SharedPreferencesBrightnessPersistence : IBrightnessPersistence
    {
        public const string PrefsName = "fitbaus_bike_bridge_brightness";
        public const string PercentKey = "percent";

        private readonly ISharedPreferences _prefs;

        public SharedPreferencesBrightnessPersistence(Context context)
        {
            if (context == null)
            {
                throw new System.ArgumentNullException("context");
            }

            Context app = context.ApplicationContext ?? context;
            _prefs = app.GetSharedPreferences(PrefsName, FileCreationMode.Private);
        }

        public bool TryLoad(out int percent)
        {
            percent = 0;
            if (_prefs == null || !_prefs.Contains(PercentKey))
            {
                return false;
            }

            percent = _prefs.GetInt(PercentKey, int.MinValue);
            return true;
        }

        public void Save(int percent)
        {
            if (_prefs == null)
            {
                return;
            }

            ISharedPreferencesEditor editor = _prefs.Edit();
            editor.PutInt(PercentKey, percent);
            editor.Commit();
        }
    }
}
