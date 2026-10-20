using System.Collections.Generic;
using Fitbaus.BikeBridge.Core;
using Xunit;

namespace Fitbaus.BikeBridge.Core.Tests
{
    public class LanEndpointDisplayTests
    {
        [Fact]
        public void PrefersLanIpv4OverLoopbackAndLinkLocal()
        {
            List<LanIpv4Candidate> candidates = new List<LanIpv4Candidate>
            {
                new LanIpv4Candidate("127.0.0.1", true, true),
                new LanIpv4Candidate("169.254.10.2", true, false),
                new LanIpv4Candidate("192.168.1.42", true, false)
            };

            Assert.Equal("192.168.1.42", LanEndpointDisplay.SelectIpv4(candidates));
            Assert.Equal("192.168.1.42:8765", LanEndpointDisplay.Format(8765, candidates));
        }

        [Fact]
        public void IgnoresDownInterfaces()
        {
            List<LanIpv4Candidate> candidates = new List<LanIpv4Candidate>
            {
                new LanIpv4Candidate("10.0.0.8", false, false),
                new LanIpv4Candidate("192.168.0.5", true, false)
            };

            Assert.Equal("192.168.0.5", LanEndpointDisplay.SelectIpv4(candidates));
        }

        [Fact]
        public void UsesLinkLocalWhenNoBetterAddressExists()
        {
            List<LanIpv4Candidate> candidates = new List<LanIpv4Candidate>
            {
                new LanIpv4Candidate("127.0.0.1", true, true),
                new LanIpv4Candidate("169.254.1.1", true, false)
            };

            Assert.Equal("169.254.1.1", LanEndpointDisplay.SelectIpv4(candidates));
            Assert.Equal("169.254.1.1:8765", LanEndpointDisplay.Format(8765, candidates));
        }

        [Fact]
        public void FallsBackToBindAddressWhenEmpty()
        {
            Assert.Null(LanEndpointDisplay.SelectIpv4(new LanIpv4Candidate[0]));
            Assert.Equal("0.0.0.0:8765", LanEndpointDisplay.Format(8765, new LanIpv4Candidate[0]));
            Assert.Equal("0.0.0.0:8765", LanEndpointDisplay.Format(8765, null));
        }

        [Fact]
        public void IgnoresIpv6AndMalformed()
        {
            List<LanIpv4Candidate> candidates = new List<LanIpv4Candidate>
            {
                new LanIpv4Candidate("fe80::1", true, false),
                new LanIpv4Candidate("not-an-ip", true, false),
                new LanIpv4Candidate("172.16.4.9", true, false)
            };

            Assert.Equal("172.16.4.9", LanEndpointDisplay.SelectIpv4(candidates));
        }
    }
}
