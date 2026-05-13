// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/**
 * @title PriceOracle
 * @notice Chainlink alapú árolvasó.
 *         Mainnet-en valós feed-eket használ.
 *         Tesztneten mock feed-eket (MockAggregator).
 *
 * Elérhető eszközök:
 *   BTC, ETH, MATIC, XAU (arany), XAG (ezüst), XOI (olaj/WTI)
 *   + mock feed részvényekhez (TSLA, GOOGL) tesztelésre
 */
contract PriceOracle {

    address public admin;

    struct Feed {
        AggregatorV3Interface aggregator;
        string symbol;
        uint8 decimals;
        bool active;
    }

    mapping(bytes32 => Feed) public feeds;
    bytes32[] public feedKeys;

    event FeedAdded(bytes32 indexed key, string symbol, address aggregator);
    event FeedUpdated(bytes32 indexed key, address newAggregator);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Csak admin");
        _;
    }

    constructor(bool isTestnet) {
        admin = msg.sender;

        if (!isTestnet) {
            // ── Polygon Mainnet feed-ek ──────────────────────────────
            _addFeed("BTC",   "BTC/USD",  0xc907E116054Ad103354f2D350FD2514433D57F6f, 8);
            _addFeed("ETH",   "ETH/USD",  0xF9680D99D6C9589e2a93a78A04A279e509205945, 8);
            _addFeed("MATIC", "MATIC/USD",0xAB594600376Ec9fD91F8e885dADF0CE036862dE0, 8);
            _addFeed("XAU",   "XAU/USD",  0x0c466540B2ee1a31b441671eac0ca886e051e410, 8);
            _addFeed("XAG",   "XAG/USD",  0x5d37E4b374E6907de8Fc7fb33EE3b0af403C7403, 8);
            _addFeed("XOI",   "XOI/USD",  0x25dB7dA85B5b54b783E4a1D43cA59fCAf0b9F87B, 8);
        } else {
            // ── Polygon Amoy Testnet feed-ek ────────────────────────
            _addFeed("BTC",   "BTC/USD",  0xe7656e23fE8077D438aEfbec2fAbDf2D8e070C4f, 8);
            _addFeed("ETH",   "ETH/USD",  0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7, 8);
            _addFeed("MATIC", "MATIC/USD",0x001382149eBa3441043c1c66972b4772963f5D43, 8);
            // XAU, XAG, XOI Amoy-on nincs → mock feed-et adj hozzá
            // addMockFeed("XAU", "XAU/USD", 320000000000) // $3200.00
        }
    }

    function _addFeed(
        string memory key,
        string memory symbol,
        address aggregator,
        uint8 dec
    ) internal {
        bytes32 k = keccak256(abi.encodePacked(key));
        feeds[k] = Feed(AggregatorV3Interface(aggregator), symbol, dec, true);
        feedKeys.push(k);
        emit FeedAdded(k, symbol, aggregator);
    }

    /**
     * @notice Ár lekérdezése kulcs alapján (pl. "BTC", "XAU", "TSLA")
     * @return price  Az ár (8 tizedesjeggyel: 320000000000 = $3200.00)
     * @return updatedAt  Mikor frissült utoljára (Unix timestamp)
     */
    function getPrice(string memory key)
        external
        view
        returns (int256 price, uint256 updatedAt)
    {
        bytes32 k = keccak256(abi.encodePacked(key));
        Feed storage feed = feeds[k];
        require(feed.active, "Ismeretlen eszkoz");

        (, price, , updatedAt, ) = feed.aggregator.latestRoundData();

        // Staleness ellenőrzés: ha 2 óránál régebbi, revert
        require(
            block.timestamp - updatedAt < 7200,
            "Elertek adata tul regi"
        );
    }

    /**
     * @notice Ár USD-ben, 2 tizedesjeggyel (emberi olvasáshoz)
     *         Pl. 320000000000 → 320000 (= $3200.00 * 100)
     */
    function getPriceUSD(string memory key)
        external
        view
        returns (uint256)
    {
        (int256 price, ) = this.getPrice(key);
        require(price > 0, "Ervenytelen ar");
        return uint256(price) / 1e6; // 8 decimálisból → 2 decimális
    }

    /**
     * @notice Admin hozzáadhat új feed-et (pl. ha Chainlink TSLA-t indít)
     */
    function addFeed(
        string memory key,
        string memory symbol,
        address aggregator,
        uint8 dec
    ) external onlyAdmin {
        _addFeed(key, symbol, aggregator, dec);
    }

    /**
     * @notice Feed cím frissítése (ha Chainlink lecseréli)
     */
    function updateFeed(string memory key, address newAggregator)
        external
        onlyAdmin
    {
        bytes32 k = keccak256(abi.encodePacked(key));
        feeds[k].aggregator = AggregatorV3Interface(newAggregator);
        emit FeedUpdated(k, newAggregator);
    }

    /**
     * @notice Összes aktív feed listája a frontendnek
     */
    function getFeedCount() external view returns (uint256) {
        return feedKeys.length;
    }
}