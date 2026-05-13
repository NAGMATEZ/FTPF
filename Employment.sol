// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Counters.sol";

/**
 * @title PayFlowEmployment
 * @notice NFT alapú munkaviszony-kezelő.
 *
 *  Szerepkörök:
 *    DEFAULT_ADMIN_ROLE  → fejlesztő (deployer)
 *    EMPLOYER_ROLE       → munkáltató (UserRegistry-ből)
 *    EMPLOYEE_ROLE       → munkavállaló (NFT tulajdonos)
 *
 *  Funkciók:
 *    mintEmploymentNFT()     → munkáltató létrehoz munkaviszonyt
 *    calculateEarnedWage()   → arányos bér az idő alapján
 *    requestPayout()         → munkavállaló kifizetést kér
 *    proposeSalaryChange()   → bármelyik fél kezdeményez módosítást
 *    approveSalaryChange()   → másik fél jóváhagyja
 *    terminateEmployment()   → felbontás (mindkét fél kezdeményezheti)
 */
contract PayFlowEmployment is ERC721, AccessControl {
    using Counters for Counters.Counter;

    bytes32 public constant EMPLOYER_ROLE = keccak256("EMPLOYER_ROLE");
    bytes32 public constant EMPLOYEE_ROLE = keccak256("EMPLOYEE_ROLE");

    Counters.Counter private _tokenIds;

    // ── Adatstruktúrák ───────────────────────────────────────────────

    enum ContractStatus { ACTIVE, TERMINATED, SUSPENDED }

    struct Employment {
        address employer;
        address employee;
        uint256 monthlySalaryHUF;   // havi nettó Ft-ban (pl. 450000)
        uint8   payday;             // hónap napja: 1–28
        uint256 startTimestamp;     // Unix timestamp
        uint256 lastPayoutTimestamp;// utolsó kifizetés időpontja
        ContractStatus status;
        string  encryptedMetadata;  // titkosított személyes adatok (AES-256)
    }

    struct SalaryProposal {
        uint256 newMonthlySalaryHUF;
        address proposedBy;
        bool    employerApproved;
        bool    employeeApproved;
        uint256 proposedAt;
        bool    exists;
    }

    struct TerminationRequest {
        address requestedBy;
        uint256 requestedAt;
        bool    employerApproved;
        bool    employeeApproved;
        bool    exists;
    }

    // tokenId → adatok
    mapping(uint256 => Employment) public employments;
    mapping(uint256 => SalaryProposal) public salaryProposals;
    mapping(uint256 => TerminationRequest) public terminationRequests;

    // wallet → tokenId-k listája
    mapping(address => uint256[]) public employerContracts;
    mapping(address => uint256) public employeeTokenId; // 1 aktív per munkavállaló

    // ── Események ────────────────────────────────────────────────────

    event EmploymentCreated(
        uint256 indexed tokenId,
        address indexed employer,
        address indexed employee,
        uint256 monthlySalaryHUF,
        uint256 startTimestamp
    );
    event PayoutRequested(
        uint256 indexed tokenId,
        address indexed employee,
        uint256 amountHUF,
        uint256 timestamp
    );
    event SalaryProposed(uint256 indexed tokenId, uint256 newSalary, address by);
    event SalaryChanged(uint256 indexed tokenId, uint256 oldSalary, uint256 newSalary);
    event TerminationRequested(uint256 indexed tokenId, address by);
    event EmploymentTerminated(uint256 indexed tokenId, uint256 timestamp);

    // ── Konstruktor ───────────────────────────────────────────────────

    constructor() ERC721("PayFlow Employment Badge", "PFEB") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ── Szerepkör kezelés ─────────────────────────────────────────────

    function grantEmployerRole(address employer)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _grantRole(EMPLOYER_ROLE, employer);
    }

    function grantEmployeeRole(address employee)
        external onlyRole(EMPLOYER_ROLE)
    {
        _grantRole(EMPLOYEE_ROLE, employee);
    }

    // ── NFT Munkaviszony létrehozása ──────────────────────────────────

    /**
     * @notice Munkáltató létrehoz munkaviszonyt és NFT-t mint a munkavállalónak.
     * @param employee          A munkavállaló wallet címe
     * @param monthlySalaryHUF  Havi nettó fizetés forintban
     * @param payday            Fizetésnap (1–28)
     * @param startTimestamp    Munkaviszony kezdete (Unix ts) — 0 = most
     * @param encryptedMetadata AES-256 titkosított személyes adatok
     */
    function mintEmploymentNFT(
        address employee,
        uint256 monthlySalaryHUF,
        uint8   payday,
        uint256 startTimestamp,
        string  memory encryptedMetadata
    ) external onlyRole(EMPLOYER_ROLE) returns (uint256) {
        require(employee != address(0), "Ervenytelen cim");
        require(monthlySalaryHUF > 0, "Fizetesnek pozitivnak kell lennie");
        require(payday >= 1 && payday <= 28, "Fizetesnap 1-28 kozott");
        require(
            employeeTokenId[employee] == 0,
            "Mar van aktiv munkaviszonya"
        );

        if (startTimestamp == 0) startTimestamp = block.timestamp;

        _tokenIds.increment();
        uint256 tokenId = _tokenIds.current();

        _safeMint(employee, tokenId);
        _grantRole(EMPLOYEE_ROLE, employee);

        employments[tokenId] = Employment({
            employer:              msg.sender,
            employee:              employee,
            monthlySalaryHUF:      monthlySalaryHUF,
            payday:                payday,
            startTimestamp:        startTimestamp,
            lastPayoutTimestamp:   startTimestamp,
            status:                ContractStatus.ACTIVE,
            encryptedMetadata:     encryptedMetadata
        });

        employerContracts[msg.sender].push(tokenId);
        employeeTokenId[employee] = tokenId;

        emit EmploymentCreated(
            tokenId, msg.sender, employee,
            monthlySalaryHUF, startTimestamp
        );

        return tokenId;
    }

    // ── Bérszámítás ───────────────────────────────────────────────────

    /**
     * @notice Kiszámolja, mennyi bér jár az utolsó kifizetés óta eltelt idő alapján.
     *         Logika: (eltelt_másodpercek / havi_másodpercek) × havi_bér
     *         Havi_másodpercek = 30.44 nap átlagosan = 2_629_743 mp
     */
    function calculateEarnedWage(uint256 tokenId)
        public view returns (uint256 earnedHUF)
    {
        Employment storage e = employments[tokenId];
        require(e.status == ContractStatus.ACTIVE, "Nem aktiv munkaviszony");

        uint256 elapsed = block.timestamp - e.lastPayoutTimestamp;
        uint256 monthlySeconds = 2_629_743; // 30.44 nap

        // Arányos számítás: pontosabb mint kerekíteni
        earnedHUF = (e.monthlySalaryHUF * elapsed) / monthlySeconds;
    }

    /**
     * @notice Az aktuálisan felvehető maximális összeg
     *         (nem lehet több mint a teljes havi bér)
     */
    function getMaxPayout(uint256 tokenId)
        public view returns (uint256)
    {
        uint256 earned = calculateEarnedWage(tokenId);
        Employment storage e = employments[tokenId];
        return earned > e.monthlySalaryHUF ? e.monthlySalaryHUF : earned;
    }

    // ── Kifizetés ─────────────────────────────────────────────────────

    /**
     * @notice Munkavállaló kifizetést kér.
     *         A tényleges átutalás off-chain (céges bankszámla),
     *         a blokklánc csak rögzíti az igényt és frissíti az időbélyeget.
     *
     * Éles rendszerben itt lehetne: USDC transfer, vagy webhook a banknak.
     */
    function requestPayout(uint256 tokenId, uint256 amountHUF)
        external onlyRole(EMPLOYEE_ROLE)
    {
        Employment storage e = employments[tokenId];
        require(e.employee == msg.sender, "Nem a te szerzodesed");
        require(e.status == ContractStatus.ACTIVE, "Nem aktiv");

        uint256 maxPayout = getMaxPayout(tokenId);
        require(amountHUF <= maxPayout, "Tobb mint a ledolgozott ber");
        require(amountHUF > 0, "Nullas kifizetesi igenyles");

        // Arányos időbélyeg visszaállítás
        // Ha a teljes összeget kéri: reset a mostani időre
        // Ha részlegest: arányosan tolja vissza
        uint256 monthlySeconds = 2_629_743;
        uint256 paidSeconds = (amountHUF * monthlySeconds) / e.monthlySalaryHUF;
        e.lastPayoutTimestamp = e.lastPayoutTimestamp + paidSeconds;

        emit PayoutRequested(tokenId, msg.sender, amountHUF, block.timestamp);
    }

    // ── Bérváltoztatás ────────────────────────────────────────────────

    /**
     * @notice Bármelyik fél javasolhat bérváltoztatást.
     *         Érvényesül ha a másik fél is jóváhagyja.
     */
    function proposeSalaryChange(uint256 tokenId, uint256 newSalaryHUF)
        external
    {
        Employment storage e = employments[tokenId];
        require(
            msg.sender == e.employer || msg.sender == e.employee,
            "Nem vagy resztvevo"
        );
        require(e.status == ContractStatus.ACTIVE, "Nem aktiv");
        require(newSalaryHUF > 0, "Ervenytelen osszeg");

        bool isEmployer = (msg.sender == e.employer);
        salaryProposals[tokenId] = SalaryProposal({
            newMonthlySalaryHUF: newSalaryHUF,
            proposedBy:         msg.sender,
            employerApproved:   isEmployer,
            employeeApproved:   !isEmployer,
            proposedAt:         block.timestamp,
            exists:             true
        });

        emit SalaryProposed(tokenId, newSalaryHUF, msg.sender);
    }

    /**
     * @notice A másik fél jóváhagyja a javaslatot → bér módosul
     */
    function approveSalaryChange(uint256 tokenId) external {
        Employment storage e = employments[tokenId];
        SalaryProposal storage p = salaryProposals[tokenId];
        require(p.exists, "Nincs aktiv javaslat");
        require(
            msg.sender == e.employer || msg.sender == e.employee,
            "Nem vagy resztvevo"
        );

        if (msg.sender == e.employer) p.employerApproved = true;
        if (msg.sender == e.employee) p.employeeApproved = true;

        if (p.employerApproved && p.employeeApproved) {
            uint256 oldSalary = e.monthlySalaryHUF;
            e.monthlySalaryHUF = p.newMonthlySalaryHUF;
            p.exists = false;
            emit SalaryChanged(tokenId, oldSalary, p.newMonthlySalaryHUF);
        }
    }

    // ── Felbontás ─────────────────────────────────────────────────────

    /**
     * @notice Felbontás kezdeményezése (bármelyik féltől)
     *         Mindkét fél jóváhagyása után érvényes.
     *         (Munkavállaló azonnali felbontásnál is jár az arányos bér.)
     */
    function requestTermination(uint256 tokenId) external {
        Employment storage e = employments[tokenId];
        require(
            msg.sender == e.employer || msg.sender == e.employee,
            "Nem vagy resztvevo"
        );
        require(e.status == ContractStatus.ACTIVE, "Nem aktiv");

        bool isEmployer = (msg.sender == e.employer);
        terminationRequests[tokenId] = TerminationRequest({
            requestedBy:      msg.sender,
            requestedAt:      block.timestamp,
            employerApproved: isEmployer,
            employeeApproved: !isEmployer,
            exists:           true
        });

        emit TerminationRequested(tokenId, msg.sender);
    }

    function approveTermination(uint256 tokenId) external {
        Employment storage e = employments[tokenId];
        TerminationRequest storage t = terminationRequests[tokenId];
        require(t.exists, "Nincs aktiv felbontasi kerelem");

        if (msg.sender == e.employer) t.employerApproved = true;
        if (msg.sender == e.employee) t.employeeApproved = true;

        if (t.employerApproved && t.employeeApproved) {
            e.status = ContractStatus.TERMINATED;
            employeeTokenId[e.employee] = 0;
            t.exists = false;
            emit EmploymentTerminated(tokenId, block.timestamp);
        }
    }

    // ── Lekérdezések ──────────────────────────────────────────────────

    /**
     * @notice Munkáltató összes szerződése — a munkáltatói UI ezt hívja
     */
    function getEmployerContracts(address employer)
        external view returns (uint256[] memory)
    {
        return employerContracts[employer];
    }

    /**
     * @notice Munkaviszony teljes adatsora
     */
    function getEmployment(uint256 tokenId)
        external view
        returns (Employment memory)
    {
        return employments[tokenId];
    }

    /**
     * @notice ERC721 + AccessControl együttélés
     */
    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}