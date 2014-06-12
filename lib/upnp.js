var url     = require("url");
var http    = require("http");
var dgram   = require("dgram");
var util    = require("util");
var events  = require("events");
var _       = require("underscore");
var xml2js   = require("xml2js");

// SSDP
const SSDP_PORT = 1900;
const BROADCAST_ADDR = "239.255.255.250";
const SSDP_ALIVE = 'ssdp:alive';
const SSDP_BYEBYE = 'ssdp:byebye';
const SSDP_UPDATE = 'ssdp:update';
const SSDP_ALL = 'ssdp:all';

// Map SSDP notification sub type to emitted events 
const UPNP_NTS_EVENTS = {
  'ssdp:alive': 'DeviceAvailable',
  'ssdp:byebye': 'DeviceUnavailable',
  'ssdp:update': 'DeviceUpdate'
};

var debug;
if (process.env.NODE_DEBUG && /upnp/.test(process.env.NODE_DEBUG)) {
  debug = function(x) { console.error('UPNP: %s', x); };

} else {
  debug = function() { };
}

function ControlPoint() {
  events.EventEmitter.call(this);
  this.server = dgram.createSocket('udp4');
  var self = this;
  this.server.on('message', function(msg, rinfo) {self.onRequestMessage(msg, rinfo);});
  this._initParsers();
  this.server.bind(SSDP_PORT, function () {
    self.server.addMembership(BROADCAST_ADDR);
  });
}
util.inherits(ControlPoint, events.EventEmitter);
exports.ControlPoint = ControlPoint;

/**
 * Message handler for HTTPU request.
 */
ControlPoint.prototype.onRequestMessage = function(msg, rinfo) {
  var ret = this.requestParser.execute(msg, 0, msg.length);
  if (!(ret instanceof Error)) {
    var req = this.requestParser.incoming;
    switch (req.method) {
      case 'NOTIFY':
        debug('NOTIFY ' + req.headers.nts + ' NT=' + req.headers.nt + ' USN=' + req.headers.usn);
        var event = UPNP_NTS_EVENTS[req.headers.nts];
        if (event) {
          this.emit(event, req.headers);
        }
        break;
    };
  }
};

/**
 * Initialize HTTPU response and request parsers.
 */
ControlPoint.prototype._initParsers = function() {
  var self = this;
  if (!self.requestParser) {
    self.requestParser = http.parsers.alloc();
    self.requestParser.reinitialize('request');
    self.requestParser.onIncoming = function(req) {

    };
  }
};

/**
 * Message handler for MSEARCH HTTPU response.
 */
ControlPoint.prototype.onMSearchResponseMessage = function(msg, rinfo) {
    var device = {},
        headers = msg.toString('ascii').split('\r\n');
    if (headers[0] === 'HTTP/1.1 200 OK') {
      _.each(headers,  function (header) {
        var tuple = header.split(': ');
        if (tuple[1]) {
          device[tuple[0].toLowerCase()] = tuple[1]
        }
      });
    }
    this.emit("DeviceFound", device);
};

/**
 * Send an SSDP search request.
 * 
 * Listen for the <code>DeviceFound</code> event to catch found devices or services.
 * 
 * @param String st
 *  The search target for the request (optional, defaults to "ssdp:all"). 
 */
ControlPoint.prototype.search = function(st) {
  if (typeof st !== 'string') {
    st = SSDP_ALL;
  }

  var message = 
    "M-SEARCH * HTTP/1.1\r\n"+
    "Host:"+BROADCAST_ADDR+":"+SSDP_PORT+"\r\n"+
    "ST:"+st+"\r\n"+
    "Man:\"ssdp:discover\"\r\n"+
    "MX:2\r\n\r\n",
    client = dgram.createSocket("udp4"),
    server = dgram.createSocket('udp4'),
    self = this;

  server.on('message', function(msg, rinfo) {
    self.onMSearchResponseMessage(msg, rinfo);
  });

  server.on('listening', function () {
    client.send(new Buffer(message, "ascii"), 0, message.length, SSDP_PORT, BROADCAST_ADDR, function () {
      client.close();
    });
  });

  client.on('listening', function () {
    server.bind(client.address().port);
  });

  client.bind();

  // MX is set to 2, wait for 1 additional sec. before closing the server
  setTimeout(function(){
    server.close();
  }, 3000);
}

/**
 * Terminates this ControlPoint.
 */
ControlPoint.prototype.close = function() {
  this.server.close();
  http.parsers.free(this.requestParser);
}

/* TODO Move these stuff to a separated module/project */

//some const strings - dont change
const GW_ST    = "urn:schemas-upnp-org:device:InternetGatewayDevice:1";
const WANIP = "urn:schemas-upnp-org:service:WANIPConnection:1";
const WANDEVICE = "urn:schemas-upnp-org:device:WANDevice:1";
const WANCONNDEVICE = "urn:schemas-upnp-org:device:WANConnectionDevice:1";
const OK    = "HTTP/1.1 200 OK";
const SOAP_ENV_PRE = "<?xml version=\"1.0\"?>\n<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>";
const SOAP_ENV_POST = "</s:Body></s:Envelope>";

function find_by_type(needle, type, haystack) {
    var thing = null;

    if (haystack[type+"List"]) {
        thing = haystack[type+"List"][0][type].filter(function (thing) {
            return thing[type+"Type"][0] == needle;
        })[0];
    }

    return thing;
};

function find_device(deviceType, xml) {
    return find_by_type(deviceType, "device", xml);
};

function find_service(serviceType, xml) {
    return find_by_type(serviceType, "service", xml);
};

function searchGateway(timeout, callback) {
  var requests = {};
  var t;
  
  if (timeout) {
    t = setTimeout(function() {
      callback(new Error("searchGateway() timed out"));
    }, timeout);
  }
  
  var cp = new ControlPoint();
  cp.on('DeviceFound', function(headers) {
    var location = url.parse(headers.location);
    location.port = location.port || (location.protocol == "https:" ? 443 : 80);
    // Early return if this location is already processed 
    if (requests[location.href]) return;

    // Retrieve device/service description
   
      var request = requests[location.href] = http.request(location, function (response) {
          if (response.statusCode !== 200) {
              callback(new Error("Unexpected response status code: " + response.statusCode));
          }
          var resbuf = "";
          response.setEncoding("utf8");
          response.on('data', function (chunk) { resbuf += chunk;});
          response.on("end", function() {
              xml2js.parseString(resbuf, function (err, data) {
                  data = data.root;
                  var baseURL = data.URLBase || "";

                  var wandevice = find_device(WANDEVICE, data.device[0]),
                      conndevice = find_device(WANCONNDEVICE, wandevice),
                      wanip = find_service(WANIP, conndevice);

                  var controlURL = url.parse(baseURL[0] + wanip.controlURL[0]);
                  
                  clearTimeout(t);

                  callback(null, new Gateway(controlURL.port, 
                                             controlURL.hostname, 
                                             controlURL.pathname));
              });
          });
      });
      request.on("error", function (e) {
          callback(e);
      });
      request.end();
  });
  
  cp.search(GW_ST);
}
exports.searchGateway = searchGateway;

function Gateway(port, host, path) {
  this.port = port;
  this.host = host;
  this.path = path;
}

// Retrieves the values of the current connection type and allowable connection types.
Gateway.prototype.GetConnectionTypeInfo = function(callback) {
  this._getSOAPResponse(
    "<u:GetConnectionTypeInfo xmlns:u=\"" + WANIP + "\">\
    </u:GetConnectionTypeInfo>",
    "GetConnectionTypeInfo",
    function(err, response) {
      if (err) return callback(err);
      var rtn = {};
      try {
        rtn['NewConnectionType'] = this._getArgFromXml(response.body, "NewConnectionType", true);
        rtn['NewPossibleConnectionTypes'] = this._getArgFromXml(response.body, "NewPossibleConnectionTypes", true);
      } catch(e) {
        return callback(e);
      }
      callback.apply(null, this._objToArgs(rtn));
    }
  );
}

Gateway.prototype.GetExternalIPAddress = function(callback) {
  this._getSOAPResponse(
    "<u:GetExternalIPAddress xmlns:u=\"" + WANIP + "\">\
    </u:GetExternalIPAddress>",
    "GetExternalIPAddress",
    function(err, response) {
      if (err) return callback(err);
      var rtn = {};
      try {
        rtn['NewExternalIPAddress'] = this._getArgFromXml(response.body, "NewExternalIPAddress", true);
      } catch(e) {
        return callback(e);
      }
      callback.apply(null, this._objToArgs(rtn));
    }
  );
}

Gateway.prototype.AddPortMapping = function(protocol, extPort, intPort, host, description, callback) {
  this._getSOAPResponse(
    "<u:AddPortMapping \
    xmlns:u=\""+WANIP+"\">\
    <NewRemoteHost></NewRemoteHost>\
    <NewExternalPort>"+extPort+"</NewExternalPort>\
    <NewProtocol>"+protocol+"</NewProtocol>\
    <NewInternalPort>"+intPort+"</NewInternalPort>\
    <NewInternalClient>"+host+"</NewInternalClient>\
    <NewEnabled>1</NewEnabled>\
    <NewPortMappingDescription>"+description+"</NewPortMappingDescription>\
    <NewLeaseDuration>0</NewLeaseDuration>\
    </u:AddPortMapping>",
    "AddPortMapping",
    function(err, response) {
      if (err) return callback(err);
    }
  );
}

Gateway.prototype._getSOAPResponse = function(soap, func, callback) {
  var self = this;
  var s = new Buffer(SOAP_ENV_PRE+soap+SOAP_ENV_POST, "utf8");
  var client = http.createClient(this.port, this.host);
  var request = client.request("POST", this.path, {
    "Host"           : this.host + (this.port != 80 ? ":" + this.port : ""),
    "SOAPACTION"     : '"' + WANIP + '#' + func + '"',
    "Content-Type"   : "text/xml",
    "Content-Length" : s.length
  });
  request.addListener('error', function(error) {
    callback.call(self, error);
  });
  request.addListener('response', function(response) {
    if (response.statusCode === 402) {
      return callback.call(self, new Error("Invalid Args"));
    } else if (response.statusCode === 501) {
      return callback.call(self, new Error("Action Failed"));      
    }
    response.body = "";
    response.setEncoding("utf8");
    response.addListener('data', function(chunk) { response.body += chunk });
    response.addListener('end', function() {
      callback.call(self, null, response);
    });
  });
  request.end(s);
}

// Formats an Object of named arguments, and returns an Array of return
// values that can be used with "callback.apply()".
Gateway.prototype._objToArgs = function(obj) {
  var wrapper;
  var rtn = [null];
  for (var i in obj) {
    if (!wrapper) {
      wrapper = new (obj[i].constructor)(obj[i]);
      wrapper[i] = obj[i];
      rtn.push(wrapper);
    } else {
      wrapper[i] = obj[i];
      rtn.push(obj[i]);
    }
  }
  return rtn;
}

Gateway.prototype._getArgFromXml = function(xml, arg, required) {
  var match = xml.match(new RegExp("<"+arg+">(.+?)<\/"+arg+">"));
  if (match) {
    return match[1];
  } else if (required) {
    throw new Error("Invalid XML: Argument '"+arg+"' not given.");
  }
}
