// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title UserRegistry
 * @notice Nyilvántartja, ki munkáltató és ki munkavállaló.
 *         A fejlesztő deployal, ő az első admin.
 *         Munkáltatók regisztrálhatnak önállóan (self-serve).
 *         Munkavállalók a munkáltató meghívójával kerülnek be.
 */
contract UserRegistry {

    enum Role { NONE, EMPLOYER, EMPLOYEE }

    struct UserProfile {
        Role role;
        address registeredBy;   // ki regisztrálta (0x0 = önmaga)
        uint256 registeredAt;
        bool active;
    }

    address public admin;
    mapping(address => UserProfile) public profiles;
    address[] public employers;
    address[] public employees;

    event EmployerRegistered(address indexed employer, uint256 timestamp);
    event EmployeeRegistered(address indexed employee, address indexed byEmployer, uint256 timestamp);
    event UserDeactivated(address indexed user);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Csak admin");
        _;
    }

    modifier onlyEmployer() {
        require(profiles[msg.sender].role == Role.EMPLOYER, "Csak munkaltato");
        require(profiles[msg.sender].active, "Inaktiv fiok");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    /**
     * @notice Munkáltató önállóan regisztrál (self-serve)
     *         Bárki regisztrálhat munkáltatóként — éles rendszerben
     *         itt lehetne email/domain verifikáció vagy admin jóváhagyás.
     */
    function registerAsEmployer() external {
        require(profiles[msg.sender].role == Role.NONE, "Mar regisztralt");
        profiles[msg.sender] = UserProfile({
            role: Role.EMPLOYER,
            registeredBy: address(0),
            registeredAt: block.timestamp,
            active: true
        });
        employers.push(msg.sender);
        emit EmployerRegistered(msg.sender, block.timestamp);
    }

    /**
     * @notice Munkáltató meghív egy munkavállalót (wallet cím alapján)
     *         A munkavállaló NFT-t kap a PayFlowEmployment szerződéstől.
     */
    function registerEmployee(address employee) external onlyEmployer {
        require(employee != address(0), "Ervenytelen cim");
        require(profiles[employee].role == Role.NONE, "Mar regisztralt");
        profiles[employee] = UserProfile({
            role: Role.EMPLOYEE,
            registeredBy: msg.sender,
            registeredAt: block.timestamp,
            active: true
        });
        employees.push(employee);
        emit EmployeeRegistered(employee, msg.sender, block.timestamp);
    }

    /**
     * @notice Szerepkör és státusz lekérdezése — a frontend ezt hívja
     */
    function getRole(address user) external view returns (Role) {
        return profiles[user].role;
    }

    function isEmployer(address user) external view returns (bool) {
        return profiles[user].role == Role.EMPLOYER && profiles[user].active;
    }

    function isEmployee(address user) external view returns (bool) {
        return profiles[user].role == Role.EMPLOYEE && profiles[user].active;
    }

    function getAllEmployers() external view returns (address[] memory) {
        return employers;
    }

    /**
     * @notice Admin deaktiválhat fiókot (pl. visszaélés esetén)
     */
    function deactivateUser(address user) external onlyAdmin {
        profiles[user].active = false;
        emit UserDeactivated(user);
    }

    /**
     * @notice Admin átadhatja a jogosultságot
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        admin = newAdmin;
    }
}