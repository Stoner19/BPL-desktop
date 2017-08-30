(function(){
  'use strict';

  angular.module('bplclient')
         .service('networkService', ['$q', '$http', '$timeout', 'storageService', NetworkService]);

  /**
   * NetworkService
   * @constructor
   */
  function NetworkService($q,$http,$timeout,storageService){

    var network=switchNetwork(storageService.getContext());

    var bpl = require('bpljs');
    bpl.crypto.setNetworkVersion(network.version || 25);

    var clientVersion = require('../../package.json').version;

    var peer={ip:network.peerseed, network:storageService.getContext(), isConnected:false, height:0, lastConnection:null};

    var connection=$q.defer();

    connection.notify(peer);

    function setNetwork(name, newnetwork){
      var n = storageService.getGlobal("networks");
      n[name]=newnetwork;
      storageService.setGlobal("networks",n);
    }

    function removeNetwork(name){
      var n = storageService.getGlobal("networks");
      delete n[name];
      storageService.setGlobal("networks",n);
    }

    function createNetwork(data){
      var n = storageService.getGlobal("networks");
      var newnetwork = data
      var deferred = $q.defer();
      if(n[data.name]){
        deferred.reject("Network name '"+data.name+"' already taken, please choose another one");
      }
      else {
        $http({
          url: data.peerseed + "/api/loader/autoconfigure",
          method: 'GET',
          timeout:5000
        }).then(
          function(resp){
            newnetwork = resp.data.network;
            newnetwork.forcepeer = data.forcepeer;
            newnetwork.peerseed = data.peerseed;
            n[data.name] = newnetwork;
            storageService.setGlobal("networks",n);
            deferred.resolve(n[data.name]);
          },
          function(resp){
            deferred.reject("Cannot connect to peer to autoconfigure the network");
          }
        );
      }
      return deferred.promise;
    }

    function switchNetwork(newnetwork, reload){
      if(!newnetwork){ //perform round robin
        var n = storageService.getGlobal("networks");
        var keys = Object.keys(n);
        var i = keys.indexOf(storageService.getContext())+1;
        if(i == keys.length){
          i=0;
        }
        storageService.switchContext(keys[i]);
        return window.location.reload();
      }
      storageService.switchContext(newnetwork);
      var n = storageService.getGlobal("networks");
      if(!n){
        n = {
          mainnet:{
            nethash:'7bfb2815effb43592ccdd4fd0f657c082a7b318eed12f6396cc174d8578293c3',
            peerseed:'http://13.56.163.57:4001',
            forcepeer: false,
            token: 'BLOCKPOOL',
            symbol: 'β',
            version: 0x19,
            explorer: 'http://13.56.163.57:4002',
            exchanges: {
              changer: "bpl_BPL"
            },
            background:"url(assets/images/blockpool.jpg)"
          },
          testnet:{
            nethash:'f9b98b78d2012ba8fd75538e3569bbc071ce27f0f93414218bc34bc72bdeb3db',
            peerseed:'http://52.66.184.223:4000',
            token: 'TEST_BLOCKPOOL',
            symbol: 'Tβ',
            version: 0x19,
            explorer: 'http://52.66.184.223:4010',
            background:"url(assets/images/blockpool.jpg)"
          },
          devnet:{
            nethash:'022293302aa4c24a98f1007645afe2d8b98f34e2c6fbf367c78d0bd389c6264f',
            peerseed:'http://34.253.216.124:4000',
            forcepeer: false,
            token: 'DEV_BLOCKPOOL',
            symbol: 'Dβ',
            version: 0x19,
            explorer: 'http://54.199.172.202:4001',
            exchanges: {
              changer: "bpl_BPL"
            },
            background:"url(assets/images/blockpool.jpg)"
          }
        };
        storageService.setGlobal("networks",n);
      }
      if(reload){
        return window.location.reload();
      }
      return n[newnetwork];
    }

    function getNetwork(){
      return network;
    }

    function getNetworks(){
      return storageService.getGlobal("networks");
    }

    function getPrice(){
      // peer.market={
      //   price: { btc: '0' },
      // };
      $http.get("http://coinmarketcap.northpole.ro/api/v5/"+network.token+".json",{timeout: 2000})
      .then(function(res){
        storageService.set('lastPrice', { market: res.data, date: new Date() }, true);
        peer.market=res.data;
      },function(){
        var lastPrice = storageService.get('lastPrice');

        if (typeof lastPrice === 'undefined') {
          peer.market = { price: { btc: "0.0"} };
          return;
        }

        peer.market = lastPrice.market;
        peer.market.lastUpdate = lastPrice.date;
        peer.market.isOffline = true;
      });
      $timeout(function(){
        getPrice();
      },5*60000);
    }

    function listenNetworkHeight(){
      $http.get(peer.ip+"/api/blocks/getheight",{timeout:5000}).then(function(resp){
        peer.lastConnection=new Date();
        if(resp.data && resp.data.success){
          if(peer.height==resp.data.height){
            peer.isConnected=false;
            peer.error="Node is experiencing sychronisation issues";
            connection.notify(peer);
            pickRandomPeer();
          }
          else{
            peer.height=resp.data.height;
            peer.isConnected=true;
            connection.notify(peer);
          }
        }
        else{
          peer.isConnected=false;
          peer.error=resp.statusText || "Peer Timeout after 5s";
          connection.notify(peer);
        }
      });
      $timeout(function(){
        listenNetworkHeight();
      },60000);
    }

    function getFromPeer(api){
      var deferred = $q.defer();
      peer.lastConnection=new Date();
      $http({
        url: peer.ip + api,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'os': 'bpl-desktop',
          'version': clientVersion,
          'port': 1,
          'nethash': network.nethash
        },
        timeout:5000
      }).then(
        function(resp){
          deferred.resolve(resp.data);
          peer.isConnected=true;
          peer.delay=new Date().getTime()-peer.lastConnection.getTime();
          connection.notify(peer);
        },
        function(resp){
          deferred.reject("Peer disconnected");
          peer.isConnected=false;
          peer.error=resp.statusText || "Peer Timeout after 5s";
          connection.notify(peer);
        }
      );
      return deferred.promise;
    }

    function broadcastTransaction(transaction, max){
      var peers = storageService.get("peers");
      if(!peers){
        return;
      }
      if(!max){
        max=10;
      }
      for(var i = 0 ; i<max ; i++){
        if(i < peers.length){
          postTransaction(transaction, "http://"+peers[i].ip+":"+peers[i].port);
        }
      }
    }

    function postTransaction(transaction, ip){
      var deferred = $q.defer();
      var peerip = ip;
      if(!peerip){
        peerip=peer.ip;
      }
      $http({
        url: peerip+'/peer/transactions',
        data: { transactions: [transaction] },
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'os': 'bpl-desktop',
          'version': clientVersion,
          'port': 1,
          'nethash': network.nethash
        }
      }).then(function(resp){
        if(resp.data.success){
          // we make sure that tx is well broadcasted
          if(!ip){
            broadcastTransaction(transaction);
          }
          deferred.resolve(transaction);
        }
        else{
          deferred.reject(resp.data);
        }
      });
      return deferred.promise;
    }

    function pickRandomPeer(){
      if(!network.forcepeer){
        getFromPeer("/api/peers").then(function(response){
          if(response.success){
            storageService.set("peers",response.peers.filter(function(peer){
              return peer.status=="OK";
            }));
            findGoodPeer(response.peers,0);
          }
          else{
            findGoodPeer(storageService.get("peers"),0);
          }
        }, function(error){
          findGoodPeer(storageService.get("peers"),0);
        });
      }
    }

    function findGoodPeer(peers, index){
      if(index>peers.length-1){
        //peer.ip=network.peerseed;
        return;
      }
      peer.ip="http://"+peers[index].ip+":"+peers[index].port;
      getFromPeer("/api/blocks/getheight").then(function(response){
        if(response.success && response.height<peer.height){
          findGoodPeer(peers, index+1);
        }
        else {
          peer.height=response.height;
        }
      },
      function(error){
        findGoodPeer(peers, index+1);
      });
    }

    function getPeer(){
      return peer;
    }

    function getConnection(){
      return connection.promise;
    }

    function getLatestClientVersion() {
        var deferred = $q.defer();
        var url = 'https://api.github.com/repos/ArkEcosystem/ark-desktop/releases/latest';
        $http.get(url, {timeout: 5000})
            .then(function(res) {
                deferred.resolve(res.data.tag_name);
            }, function(e) {
                // deferred.reject(gettextCatalog.getString("Cannot get latest version"));
            });
        return deferred.promise;
    }

    listenNetworkHeight();
    getPrice();
    pickRandomPeer();


    return {
      switchNetwork: switchNetwork,
      setNetwork: setNetwork,
      createNetwork: createNetwork,
      removeNetwork: removeNetwork,
      getNetwork: getNetwork,
      getNetworks: getNetworks,
      getPeer: getPeer,
      getConnection: getConnection,
      getFromPeer: getFromPeer,
      postTransaction: postTransaction,
      broadcastTransaction: broadcastTransaction,
      pickRandomPeer: pickRandomPeer,
      getLatestClientVersion: getLatestClientVersion
    };
  }

})();
