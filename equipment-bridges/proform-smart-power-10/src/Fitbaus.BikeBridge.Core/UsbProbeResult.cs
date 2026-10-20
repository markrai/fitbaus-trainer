namespace Fitbaus.BikeBridge.Core
{
    public sealed class UsbProbeResult
    {
        public static UsbProbeResult None()
        {
            return new UsbProbeResult(false, false, 0, 0, null, "USB device not found");
        }

        public UsbProbeResult(
            bool found,
            bool hasPermission,
            int vendorId,
            int productId,
            string deviceName,
            string detail)
        {
            Found = found;
            HasPermission = hasPermission;
            VendorId = vendorId;
            ProductId = productId;
            DeviceName = deviceName;
            Detail = detail ?? string.Empty;
        }

        public bool Found { get; private set; }

        public bool HasPermission { get; private set; }

        public int VendorId { get; private set; }

        public int ProductId { get; private set; }

        public string DeviceName { get; private set; }

        public string Detail { get; private set; }

        public bool IsBrainBoard
        {
            get { return Found && VendorId == BikeUsbIds.VendorId && ProductId == BikeUsbIds.BrainBoardProductId; }
        }

        public bool IsBootloader
        {
            get { return Found && VendorId == BikeUsbIds.VendorId && ProductId == BikeUsbIds.BootloaderProductId; }
        }
    }
}
