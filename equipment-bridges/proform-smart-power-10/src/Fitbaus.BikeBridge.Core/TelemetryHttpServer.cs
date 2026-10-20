using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace Fitbaus.BikeBridge.Core
{
    /// <summary>
    /// Minimal TCP HTTP listener for API 22 / MonoAndroid v7.0.
    /// GET /health, GET /api/v1/telemetry, GET /api/v1/status,
    /// POST /api/v1/resistance, POST /api/v1/heartrate (display ingest only),
    /// POST /api/v1/brightness (console window brightness).
    /// No ASP.NET.
    /// </summary>
    public sealed class TelemetryHttpServer : ITelemetryHttpServer
    {
        public const int MaxRequestBytes = 8192;

        private readonly TelemetryHttpResponder _responder;
        private readonly TelemetryListenOptions _options;
        private readonly Action<string> _log;
        private readonly object _gate = new object();

        private TcpListener _listener;
        private Thread _acceptThread;
        private volatile bool _running;
        private bool _disposed;

        public TelemetryHttpServer(TelemetryHttpResponder responder, TelemetryListenOptions options, Action<string> log)
        {
            if (responder == null)
            {
                throw new ArgumentNullException("responder");
            }

            _responder = responder;
            _options = options ?? TelemetryListenOptions.Default;
            _log = log ?? new Action<string>(Ignore);
        }

        public bool IsRunning
        {
            get { return _running; }
        }

        public int BoundPort { get; private set; }

        public string BoundEndpoint
        {
            get { return _options.Address + ":" + BoundPort; }
        }

        public bool TryStart(out string error)
        {
            error = null;
            lock (_gate)
            {
                if (_disposed)
                {
                    error = "server disposed";
                    return false;
                }

                if (_running)
                {
                    return true;
                }

                IPAddress address;
                try
                {
                    address = ParseAddress(_options.Address);
                    TcpListener listener = new TcpListener(address, _options.Port);
                    listener.Start();
                    IPEndPoint endPoint = (IPEndPoint)listener.LocalEndpoint;
                    BoundPort = endPoint.Port;
                    _listener = listener;
                    _running = true;
                    _acceptThread = new Thread(AcceptLoop);
                    _acceptThread.IsBackground = true;
                    _acceptThread.Name = "FitbausTelemetryHttp";
                    _acceptThread.Start();
                    _log("HTTP service start bind=" + BoundEndpoint);
                    return true;
                }
                catch (SocketException ex)
                {
                    error = "listen failed on " + _options.DisplayEndpoint + ": " + ex.Message;
                    _log("HTTP listener startup failure: " + error);
                    StopListenerUnlocked();
                    return false;
                }
                catch (Exception ex)
                {
                    error = "listen failed on " + _options.DisplayEndpoint + ": " + ex.Message;
                    _log("HTTP listener startup failure: " + error);
                    StopListenerUnlocked();
                    return false;
                }
            }
        }

        public void Stop()
        {
            lock (_gate)
            {
                if (!_running)
                {
                    return;
                }

                _running = false;
                StopListenerUnlocked();
            }

            Thread thread = _acceptThread;
            if (thread != null && thread.IsAlive && thread != Thread.CurrentThread)
            {
                thread.Join(1000);
            }

            _log("HTTP service stop");
        }

        public void Dispose()
        {
            lock (_gate)
            {
                _disposed = true;
            }

            Stop();
        }

        private void AcceptLoop()
        {
            while (_running)
            {
                TcpClient client = null;
                try
                {
                    TcpListener listener = _listener;
                    if (listener == null)
                    {
                        return;
                    }

                    client = listener.AcceptTcpClient();
                }
                catch (SocketException)
                {
                    if (!_running)
                    {
                        return;
                    }

                    continue;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
                catch (Exception ex)
                {
                    if (!_running)
                    {
                        return;
                    }

                    _log("HTTP accept error: " + ex.Message);
                    continue;
                }

                ThreadPool.QueueUserWorkItem(HandleClient, client);
            }
        }

        private void HandleClient(object state)
        {
            TcpClient client = state as TcpClient;
            if (client == null)
            {
                return;
            }

            try
            {
                client.NoDelay = true;
                using (NetworkStream stream = client.GetStream())
                {
                    stream.ReadTimeout = 5000;
                    stream.WriteTimeout = 5000;
                    string method;
                    string path;
                    string body;
                    if (!TryReadRequest(stream, out method, out path, out body))
                    {
                        WriteResult(stream, TelemetryHttpResult.Text(400, "Bad Request", "bad request"));
                        return;
                    }

                    TelemetryHttpResult result = _responder.Handle(method, path, body);
                    WriteResult(stream, result);
                }
            }
            catch (Exception ex)
            {
                _log("HTTP client request failure: " + ex.Message);
            }
            finally
            {
                try
                {
                    client.Close();
                }
                catch
                {
                }
            }
        }

        private static bool TryReadRequest(NetworkStream stream, out string method, out string path, out string body)
        {
            method = null;
            path = null;
            body = null;
            byte[] buffer = new byte[MaxRequestBytes];
            int total = 0;
            int headerEnd = -1;
            while (total < buffer.Length)
            {
                int read = stream.Read(buffer, total, buffer.Length - total);
                if (read <= 0)
                {
                    break;
                }

                total += read;
                headerEnd = IndexOfHeaderTerminator(buffer, total);
                if (headerEnd >= 0)
                {
                    break;
                }
            }

            if (headerEnd < 0)
            {
                return false;
            }

            string headerText = Encoding.ASCII.GetString(buffer, 0, headerEnd);
            if (!TryParseRequestLine(headerText, out method, out path))
            {
                return false;
            }

            int bodyStart = headerEnd + 4;
            int already = total - bodyStart;
            if (already < 0)
            {
                already = 0;
            }

            int contentLength;
            if (!TryParseContentLength(headerText, out contentLength))
            {
                contentLength = already;
            }

            if (contentLength < 0 || bodyStart + contentLength > buffer.Length)
            {
                return false;
            }

            while (already < contentLength && total < buffer.Length)
            {
                int read = stream.Read(buffer, total, contentLength - already);
                if (read <= 0)
                {
                    break;
                }

                total += read;
                already += read;
            }

            if (already < contentLength)
            {
                return false;
            }

            body = contentLength == 0
                ? string.Empty
                : Encoding.UTF8.GetString(buffer, bodyStart, contentLength);
            return true;
        }

        private static int IndexOfHeaderTerminator(byte[] buffer, int length)
        {
            for (int i = 0; i <= length - 4; i++)
            {
                if (buffer[i] == 13 && buffer[i + 1] == 10 && buffer[i + 2] == 13 && buffer[i + 3] == 10)
                {
                    return i;
                }
            }

            return -1;
        }

        private static bool TryParseContentLength(string headerText, out int contentLength)
        {
            contentLength = 0;
            if (string.IsNullOrEmpty(headerText))
            {
                return false;
            }

            string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            for (int i = 1; i < lines.Length; i++)
            {
                string line = lines[i];
                int colon = line.IndexOf(':');
                if (colon <= 0)
                {
                    continue;
                }

                string name = line.Substring(0, colon).Trim();
                if (!string.Equals(name, "Content-Length", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string raw = line.Substring(colon + 1).Trim();
                return int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out contentLength)
                    && contentLength >= 0;
            }

            return false;
        }

        private static bool TryParseRequestLine(string headerText, out string method, out string path)
        {
            method = null;
            path = null;
            if (string.IsNullOrEmpty(headerText))
            {
                return false;
            }

            int lineEnd = headerText.IndexOf("\r\n", StringComparison.Ordinal);
            string line = lineEnd >= 0 ? headerText.Substring(0, lineEnd) : headerText;
            string[] parts = line.Split(' ');
            if (parts.Length < 2)
            {
                return false;
            }

            method = parts[0];
            path = parts[1];
            return true;
        }

        private static void WriteResult(NetworkStream stream, TelemetryHttpResult result)
        {
            byte[] bodyBytes = Encoding.UTF8.GetBytes(result.Body ?? string.Empty);
            StringBuilder headers = new StringBuilder();
            headers.Append("HTTP/1.1 ");
            headers.Append(result.StatusCode.ToString(CultureInfo.InvariantCulture));
            headers.Append(' ');
            headers.Append(result.ReasonPhrase);
            headers.Append("\r\n");
            headers.Append("Connection: close\r\n");
            headers.Append("Cache-Control: no-store\r\n");
            if (!string.IsNullOrEmpty(result.ContentType))
            {
                headers.Append("Content-Type: ");
                headers.Append(result.ContentType);
                headers.Append("\r\n");
            }

            headers.Append("Content-Length: ");
            headers.Append(bodyBytes.Length.ToString(CultureInfo.InvariantCulture));
            headers.Append("\r\n\r\n");
            byte[] headerBytes = Encoding.ASCII.GetBytes(headers.ToString());
            stream.Write(headerBytes, 0, headerBytes.Length);
            if (bodyBytes.Length > 0)
            {
                stream.Write(bodyBytes, 0, bodyBytes.Length);
            }

            stream.Flush();
        }

        private void StopListenerUnlocked()
        {
            TcpListener listener = _listener;
            _listener = null;
            if (listener == null)
            {
                return;
            }

            try
            {
                listener.Stop();
            }
            catch
            {
            }
        }

        private static IPAddress ParseAddress(string address)
        {
            if (address == "0.0.0.0")
            {
                return IPAddress.Any;
            }

            if (address == "127.0.0.1")
            {
                return IPAddress.Loopback;
            }

            return IPAddress.Parse(address);
        }

        private static void Ignore(string message)
        {
        }
    }
}
