using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Candidate IPv4 from a host interface. Used so display selection can be unit-tested
    /// without enumerating the live machine.
    /// </summary>
    public sealed class LanIpv4Candidate
    {
        public LanIpv4Candidate(string address, bool isUp, bool isLoopback)
        {
            Address = address;
            IsUp = isUp;
            IsLoopback = isLoopback;
        }

        public string Address { get; private set; }

        public bool IsUp { get; private set; }

        public bool IsLoopback { get; private set; }
    }

    /// <summary>
    /// Formats a reachable LAN IPv4:port for diagnostics. Bind remains 0.0.0.0.
    /// </summary>
    public static class LanEndpointDisplay
    {
        public static string Format(int port)
        {
            return Format(port, EnumerateLiveCandidates());
        }

        public static string Format(int port, IEnumerable<LanIpv4Candidate> candidates)
        {
            string address = SelectIpv4(candidates);
            if (string.IsNullOrEmpty(address))
            {
                address = TelemetryListenOptions.DefaultAddress;
            }

            return address + ":" + port.ToString(CultureInfo.InvariantCulture);
        }

        public static string SelectIpv4(IEnumerable<LanIpv4Candidate> candidates)
        {
            if (candidates == null)
            {
                return null;
            }

            string linkLocal = null;
            foreach (LanIpv4Candidate candidate in candidates)
            {
                if (candidate == null || !candidate.IsUp || candidate.IsLoopback)
                {
                    continue;
                }

                IPAddress parsed;
                if (!TryParseIpv4(candidate.Address, out parsed))
                {
                    continue;
                }

                if (IsLinkLocal(parsed))
                {
                    if (linkLocal == null)
                    {
                        linkLocal = parsed.ToString();
                    }

                    continue;
                }

                return parsed.ToString();
            }

            return linkLocal;
        }

        internal static IEnumerable<LanIpv4Candidate> EnumerateLiveCandidates()
        {
            List<LanIpv4Candidate> list = new List<LanIpv4Candidate>();
            NetworkInterface[] nics;
            try
            {
                nics = NetworkInterface.GetAllNetworkInterfaces();
            }
            catch
            {
                return list;
            }

            if (nics == null)
            {
                return list;
            }

            for (int i = 0; i < nics.Length; i++)
            {
                NetworkInterface nic = nics[i];
                if (nic == null)
                {
                    continue;
                }

                bool isUp = nic.OperationalStatus == OperationalStatus.Up;
                bool isLoopback = nic.NetworkInterfaceType == NetworkInterfaceType.Loopback;
                IPInterfaceProperties props;
                try
                {
                    props = nic.GetIPProperties();
                }
                catch
                {
                    continue;
                }

                if (props == null || props.UnicastAddresses == null)
                {
                    continue;
                }

                foreach (UnicastIPAddressInformation unicast in props.UnicastAddresses)
                {
                    if (unicast == null || unicast.Address == null)
                    {
                        continue;
                    }

                    if (unicast.Address.AddressFamily != AddressFamily.InterNetwork)
                    {
                        continue;
                    }

                    bool addressLoopback = isLoopback || IPAddress.IsLoopback(unicast.Address);
                    list.Add(new LanIpv4Candidate(unicast.Address.ToString(), isUp, addressLoopback));
                }
            }

            return list;
        }

        private static bool TryParseIpv4(string raw, out IPAddress parsed)
        {
            parsed = null;
            if (string.IsNullOrEmpty(raw))
            {
                return false;
            }

            IPAddress address;
            if (!IPAddress.TryParse(raw, out address))
            {
                return false;
            }

            if (address.AddressFamily != AddressFamily.InterNetwork)
            {
                return false;
            }

            parsed = address;
            return true;
        }

        private static bool IsLinkLocal(IPAddress address)
        {
            byte[] bytes = address.GetAddressBytes();
            return bytes.Length == 4 && bytes[0] == 169 && bytes[1] == 254;
        }
    }
}
