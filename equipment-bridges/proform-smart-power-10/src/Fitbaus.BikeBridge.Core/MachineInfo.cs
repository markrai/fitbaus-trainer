namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Identity/capability fields from Shire IConsoleInfo after EquipmentConsole.Init().
    /// Separate from observed Resistance/RPM/Watts. CanSetResistance is reported as Shire
    /// provided it and is not treated as physically authoritative. Application resistance
    /// acceptance uses ResistanceLimits (1-15), not this metadata alone.
    /// </summary>
    public sealed class MachineInfo
    {
        public static readonly MachineInfo Unknown = new MachineInfo(
            "Unknown",
            "Unknown",
            false,
            0.0,
            0,
            0,
            0);

        public MachineInfo(
            string name,
            string machineType,
            bool canSetResistance,
            double maxResistanceLevel,
            int modelNumber,
            int partNumber,
            int serialNumber)
        {
            Name = name ?? "Unknown";
            MachineType = machineType ?? "Unknown";
            CanSetResistance = canSetResistance;
            MaxResistanceLevel = maxResistanceLevel;
            ModelNumber = modelNumber;
            PartNumber = partNumber;
            SerialNumber = serialNumber;
        }

        public string Name { get; private set; }

        public string MachineType { get; private set; }

        public bool CanSetResistance { get; private set; }

        public double MaxResistanceLevel { get; private set; }

        public int ModelNumber { get; private set; }

        public int PartNumber { get; private set; }

        public int SerialNumber { get; private set; }

        public string DisplayName
        {
            get
            {
                if (!string.IsNullOrEmpty(Name) && Name != "Unknown")
                {
                    return Name + " (" + MachineType + ")";
                }

                return MachineType;
            }
        }
    }
}
