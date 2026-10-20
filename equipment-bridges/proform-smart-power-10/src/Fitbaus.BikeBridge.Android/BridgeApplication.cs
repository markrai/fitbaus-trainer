using System;
using Android.App;
using Android.Runtime;

namespace Fitbaus.BikeBridge.AndroidApp
{
    [Application(Debuggable = true, Label = "FitBaus Bike Bridge", HardwareAccelerated = true)]
    public class BridgeApplication : Application
    {
        public BridgeApplication(IntPtr javaReference, JniHandleOwnership transfer)
            : base(javaReference, transfer)
        {
        }

        public override void OnCreate()
        {
            base.OnCreate();
            Android.Util.Log.Info(Fitbaus.BikeBridge.Core.Diagnostics.LogTag, "application startup");
        }
    }
}
