namespace Fitbaus.BikeBridge.Core
{
    public static class Diagnostics
    {
        public const string LogTag = "FITBAUS_BRIDGE";

        public static string FormatTelemetry(BikeTelemetrySnapshot snapshot)
        {
            if (snapshot == null)
            {
                return "telemetry resistance=- rpm=- watts=-";
            }

            return "telemetry resistance=" + FormatObserved(snapshot.Resistance)
                + " rpm=" + FormatObserved(snapshot.Rpm)
                + " watts=" + FormatObserved(snapshot.Watts);
        }

        public static string FormatMachine(MachineInfo machine)
        {
            if (machine == null)
            {
                return "machine name= type= model= part= serial= canSetResistance= maxResistanceLevel=";
            }

            return "machine name=" + machine.Name
                + " type=" + machine.MachineType
                + " model=" + machine.ModelNumber
                + " part=" + machine.PartNumber
                + " serial=" + machine.SerialNumber
                + " canSetResistance=" + machine.CanSetResistance
                + " maxResistanceLevel=" + machine.MaxResistanceLevel;
        }

        public static string FormatUsb(UsbProbeResult probe)
        {
            if (probe == null)
            {
                return "usb found=false";
            }

            return "usb found=" + probe.Found
                + " permission=" + probe.HasPermission
                + " vid=" + probe.VendorId
                + " pid=" + probe.ProductId
                + " name=" + (probe.DeviceName ?? "")
                + " brainboard=" + probe.IsBrainBoard
                + " bootloader=" + probe.IsBootloader;
        }

        private static string FormatObserved(int? value)
        {
            return value.HasValue ? value.Value.ToString() : "-";
        }
    }
}
