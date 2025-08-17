import frappe
import requests
import json
from requests.auth import HTTPBasicAuth
from datetime import datetime, timedelta
import base64
from frappe.utils import get_datetime


@frappe.whitelist()
def test_mpesa_credentials():
	"""Test function to debug M-Pesa credentials"""
	settings = frappe.get_single("Mpesa Settings")

	result = {
		"status": "Testing M-Pesa Credentials",
		"consumer_key_present": bool(settings.consumer_key),
		"consumer_key_length": len(settings.consumer_key or ""),
		"live_test_mode": settings.live_test_mode,
	}

	# Test consumer secret access
	try:
		consumer_secret = settings.get_password("consumer_secret")
		result["consumer_secret_present"] = bool(consumer_secret)
		result["consumer_secret_length"] = len(consumer_secret or "")
	except Exception as e:
		result["consumer_secret_error"] = str(e)

	# Test passkey access
	try:
		passkey = settings.get_password("passkey")
		result["passkey_present"] = bool(passkey)
		result["passkey_length"] = len(passkey or "")
	except Exception as e:
		result["passkey_error"] = str(e)

	# Test URL construction
	auth_url = ('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
				if settings.live_test_mode == 'Test'
				else 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials')
	result["auth_url"] = auth_url

	# Test credential encoding
	if settings.consumer_key and consumer_secret:
		credentials = f"{settings.consumer_key}:{consumer_secret}"
		encoded_credentials = base64.b64encode(credentials.encode('utf-8')).decode('utf-8')
		result["encoded_credentials_length"] = len(encoded_credentials)
		result["encoded_credentials_preview"] = encoded_credentials[:20] + "..."

	return result


@frappe.whitelist()
def get_access_token():
	"""Get M-Pesa OAuth access token with comprehensive error handling"""
	settings = frappe.get_single("Mpesa Settings")

	# CRITICAL FIX: Ensure token_expiry is a datetime object before comparison
	if settings.access_token and settings.token_expiry:
		try:
			token_expiry_datetime = get_datetime(settings.token_expiry)
			if datetime.now() < token_expiry_datetime:
				return settings.access_token
		except Exception as e:
			frappe.log_error(f"Failed to convert token_expiry to datetime: {e}",
							 "M-Pesa Token Error")

	# Determine auth URL based on mode
	auth_url = ('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
				if settings.live_test_mode == 'Test'
				else 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials')

	try:
		# Get credentials with proper error handling
		consumer_secret = None
		try:
			consumer_secret = settings.get_password("consumer_secret")
		except Exception as e:
			frappe.logger().error(f"Error getting consumer_secret: {e}")
			consumer_secret = getattr(settings, 'consumer_secret', None)

		# Clean and validate credentials
		consumer_key = str(settings.consumer_key).strip() if settings.consumer_key else ""
		consumer_secret = str(consumer_secret).strip() if consumer_secret else ""

		if not consumer_key:
			frappe.throw("M-Pesa Consumer Key is missing in Mpesa Settings.")
		if not consumer_secret:
			frappe.throw("M-Pesa Consumer Secret is missing in Mpesa Settings.")
		if len(consumer_key) < 10:
			frappe.throw("M-Pesa Consumer Key appears to be too short. Please verify.")
		if len(consumer_secret) < 10:
			frappe.throw("M-Pesa Consumer Secret appears to be too short. Please verify.")

		# Create authorization header
		credentials = f"{consumer_key}:{consumer_secret}"
		encoded_credentials = base64.b64encode(credentials.encode('utf-8')).decode('utf-8')

		headers = {
			'Authorization': f'Basic {encoded_credentials}',
			'Content-Type': 'application/json',
			'User-Agent': 'Frappe-MPesa/1.0',
			'Accept': 'application/json'
		}

		# Make request
		response = requests.get(auth_url, headers=headers, timeout=30, verify=True)

		if response.status_code != 200:
			error_detail = response.text
			try:
				error_data = response.json()
				error_detail = error_data.get('errorMessage',
											  error_data.get('error_description', response.text))
			except:
				pass
			frappe.log_error(
				f"M-Pesa Auth Failed - Status: {response.status_code}, Response: {error_detail}",
				"M-Pesa Auth Error"
			)
			frappe.throw(
				f"M-Pesa Authentication failed (HTTP {response.status_code}). Error: {error_detail[:200]}")

		try:
			token_data = response.json()
		except json.JSONDecodeError:
			frappe.throw(f"Invalid JSON response from M-Pesa API: {response.text[:200]}")

		access_token = token_data.get('access_token')
		expires_in = token_data.get('expires_in')

		if not access_token:
			frappe.throw(f"No access token in response. Full response: {token_data}")

		# Save token with buffer time
		settings.access_token = access_token
		settings.token_expiry = datetime.now() + timedelta(seconds=int(expires_in) - 300)
		settings.save(ignore_permissions=True)

		frappe.logger().info("M-Pesa access token obtained successfully")
		return access_token

	except frappe.ValidationError:
		raise
	except requests.exceptions.RequestException as e:
		error_msg = f"Network error connecting to M-Pesa: {str(e)[:200]}"
		frappe.log_error(error_msg, "M-Pesa Request Error")
		frappe.throw(error_msg)
	except Exception as e:
		error_msg = f"M-Pesa integration error: {str(e)[:200]}"
		frappe.log_error(error_msg, "M-Pesa Error")
		frappe.throw(error_msg)


@frappe.whitelist()
def initiate_stk_push(phone_number, amount, pos_invoice_name=None, sales_invoice_name=None):
	"""Initiate M-Pesa STK Push - supports both POS Invoice and Sales Invoice"""
	settings = frappe.get_single("Mpesa Settings")

	# Determine which invoice type we're working with
	invoice_name = pos_invoice_name or sales_invoice_name
	invoice_doctype = "POS Invoice" if pos_invoice_name else "Sales Invoice"

	if not invoice_name:
		frappe.throw("Either pos_invoice_name or sales_invoice_name must be provided")

	# CRITICAL: Verify Invoice exists with proper error handling
	try:
		invoice_doc = frappe.get_doc(invoice_doctype, invoice_name)
	except frappe.DoesNotExistError:
		frappe.throw(
			f"{invoice_doctype} {invoice_name} does not exist. Please save the invoice first and try again.")
	except Exception as e:
		frappe.log_error(f"Error validating {invoice_doctype} {invoice_name}: {str(e)}",
						 "M-Pesa Invoice Validation")
		frappe.throw(f"Unable to validate {invoice_doctype} {invoice_name}. Error: {str(e)[:100]}")

	# Get M-Pesa access token
	try:
		token = get_access_token()
	except Exception as e:
		frappe.throw(f"Failed to authenticate with M-Pesa: {str(e)}")

	# Generate timestamp and password
	timestamp = datetime.now().strftime('%Y%m%d%H%M%S')

	try:
		passkey = settings.get_password("passkey")
		if not passkey:
			frappe.throw("M-Pesa Passkey is missing in Mpesa Settings.")
	except Exception:
		frappe.throw("Failed to retrieve M-Pesa Passkey from settings.")

	if not settings.shortcode:
		frappe.throw("M-Pesa Shortcode is missing in Mpesa Settings.")

	password = base64.b64encode(
		f"{settings.shortcode}{passkey}{timestamp}".encode('utf-8')).decode('utf-8')

	# Determine STK Push URL
	stk_url = ("https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest"
			   if settings.live_test_mode == "Test"
			   else "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest")

	headers = {
		"Authorization": f"Bearer {token}",
		"Content-Type": "application/json"
	}

	# Format phone number
	if phone_number.startswith('0'):
		phone_number = '254' + phone_number[1:]
	elif phone_number.startswith('+254'):
		phone_number = phone_number[1:]
	elif not phone_number.startswith('254'):
		frappe.throw(
			"Please provide a valid Kenyan phone number (e.g., 0722123456 or 254722123456)")

	# Create Mpesa Payment record with enhanced error handling
	try:
		payment_doc = frappe.new_doc("Mpesa Payment")

		# CRITICAL FIX: Link to the correct invoice type
		if invoice_doctype == "POS Invoice":
			payment_doc.pos_invoice = invoice_name
		else:
			payment_doc.sales_invoice = invoice_name

		payment_doc.amount = amount
		payment_doc.phone_number = phone_number
		payment_doc.status = "Initiated"
		payment_doc.insert(ignore_permissions=True)
		frappe.db.commit()

		frappe.logger().info(
			f"Created Mpesa Payment document: {payment_doc.name} for {invoice_doctype}: {invoice_name}")

	except frappe.LinkValidationError as e:
		frappe.log_error(f"Link validation error: {str(e)}", "M-Pesa Payment Creation")
		frappe.throw(
			f"Failed to create payment record. Please ensure {invoice_doctype} {invoice_name} is properly saved.")
	except Exception as e:
		frappe.log_error(f"Error creating Mpesa Payment: {str(e)}", "M-Pesa Payment Creation")
		frappe.throw(f"Failed to create payment record: {str(e)[:200]}")

	# Prepare STK Push payload
	payload = {
		"BusinessShortCode": int(settings.shortcode),
		"Password": password,
		"Timestamp": timestamp,
		"TransactionType": "CustomerPayBillOnline",
		"Amount": int(float(amount)),
		"PartyA": int(phone_number),
		"PartyB": int(settings.shortcode),
		"PhoneNumber": int(phone_number),
		"CallBackURL": settings.callback_url,
		"AccountReference": invoice_name,
		"TransactionDesc": f"Payment for {invoice_doctype} {invoice_name}"
	}

	try:
		frappe.logger().info(f"STK Push Payload: {json.dumps(payload, indent=2)}")

		response = requests.post(stk_url, json=payload, headers=headers, timeout=30)

		frappe.logger().info(f"STK Response Status: {response.status_code}")
		frappe.logger().info(f"STK Response: {response.text}")

		response.raise_for_status()
		response_data = response.json()

		# Update payment document with response
		payment_doc.reload()
		payment_doc.checkout_request_id = response_data.get("CheckoutRequestID")
		payment_doc.merchant_request_id = response_data.get("MerchantRequestID")
		payment_doc.result_code = response_data.get("ResponseCode")
		payment_doc.result_desc = response_data.get("ResponseDescription")
		payment_doc.save(ignore_permissions=True)
		frappe.db.commit()

		return response_data

	except requests.exceptions.RequestException as e:
		error_msg = f"STK Push request failed: {str(e)[:200]}"
		frappe.log_error(error_msg, "M-Pesa STK Error")
		frappe.throw(error_msg)
	except Exception as e:
		error_msg = f"STK Push error: {str(e)[:200]}"
		frappe.log_error(error_msg, "M-Pesa Error")
		frappe.throw(error_msg)


@frappe.whitelist(allow_guest=True)
def handle_callback():
	"""Enhanced M-Pesa payment callback handler"""
	if frappe.request.method != "POST":
		frappe.log_error("Invalid callback method", "M-Pesa Callback")
		return {"status": "error", "message": "Invalid method"}

	try:
		# Parse callback data
		raw_data = frappe.request.data
		frappe.logger().info(f"M-Pesa Callback Raw Data: {raw_data}")

		data = json.loads(raw_data)
		callback_metadata = data.get("Body", {}).get("stkCallback", {})

		result_code = callback_metadata.get("ResultCode")
		checkout_request_id = callback_metadata.get("CheckoutRequestID")
		merchant_request_id = callback_metadata.get("MerchantRequestID")
		result_desc = callback_metadata.get("ResultDesc", "")

		frappe.logger().info(
			f"Callback - CheckoutRequestID: {checkout_request_id}, ResultCode: {result_code}")

		# Find Mpesa Payment record
		payment_doc_name = frappe.get_value("Mpesa Payment",
											{"checkout_request_id": checkout_request_id})
		if not payment_doc_name:
			frappe.log_error(f"Unknown CheckoutRequestID: {checkout_request_id}",
							 "M-Pesa Callback")
			return {"status": "error", "message": "Payment record not found"}

		payment_doc = frappe.get_doc("Mpesa Payment", payment_doc_name)

		# Always update basic callback info
		payment_doc.result_code = str(result_code)
		payment_doc.result_desc = result_desc

		if result_code == 0:
			# Payment successful - extract transaction details
			payment_doc.status = "Completed"

			# Extract M-Pesa transaction details
			callback_items = callback_metadata.get("CallbackMetadata", {}).get("Item", [])
			transaction_details = {}

			for item in callback_items:
				name = item.get("Name", "")
				value = item.get("Value")
				transaction_details[name] = value

				# Store key transaction details
				if name == "MpesaReceiptNumber":
					payment_doc.receipt_number = value
				elif name == "TransactionDate":
					payment_doc.transaction_date = value
				elif name == "PhoneNumber":
					payment_doc.phone_number = str(value)

			frappe.logger().info(f"Transaction Details: {transaction_details}")

			# Handle payment entry creation based on invoice type
			try:
				create_payment_entries(payment_doc, transaction_details)
			except Exception as pe:
				frappe.log_error(f"Payment entry creation failed: {str(pe)}",
								 "M-Pesa Payment Entry Error")
		# Don't fail the callback, just log the error

		else:
			# Payment failed
			payment_doc.status = "Failed"
			frappe.logger().info(f"Payment failed - Code: {result_code}, Desc: {result_desc}")

		# Save payment document
		payment_doc.save(ignore_permissions=True)
		frappe.db.commit()

		frappe.logger().info(f"M-Pesa callback processed successfully for {payment_doc.name}")
		return {"status": "success", "message": "Callback processed"}

	except json.JSONDecodeError as je:
		frappe.log_error(f"Invalid JSON in callback: {str(je)}", "M-Pesa Callback JSON Error")
		return {"status": "error", "message": "Invalid JSON"}
	except Exception as e:
		frappe.log_error(f"Callback processing error: {str(e)}", "M-Pesa Callback Error")
		return {"status": "error", "message": "Processing failed"}


def create_payment_entries(payment_doc, transaction_details):
	"""Create appropriate payment entries based on invoice type"""

	# Determine invoice type and get invoice document
	if payment_doc.pos_invoice:
		invoice_name = payment_doc.pos_invoice
		invoice_doctype = "POS Invoice"

		# For POS Invoice, we typically don't create Payment Entry immediately
		# as POS Invoices are consolidated during POS closing
		frappe.logger().info(
			f"POS Invoice payment completed: {invoice_name}, Receipt: {payment_doc.receipt_number}")

		# Update POS Invoice with payment info if needed
		try:
			pos_invoice = frappe.get_doc("POS Invoice", invoice_name)
		# You might want to add custom fields to track M-Pesa details
		# pos_invoice.mpesa_receipt_number = payment_doc.receipt_number
		# pos_invoice.save(ignore_permissions=True)
		except Exception as e:
			frappe.log_error(f"Error updating POS Invoice: {str(e)}", "POS Invoice Update Error")

	elif payment_doc.sales_invoice:
		invoice_name = payment_doc.sales_invoice
		invoice_doctype = "Sales Invoice"

		# For Sales Invoice, create Payment Entry
		try:
			create_sales_invoice_payment_entry(payment_doc, transaction_details)
		except Exception as e:
			frappe.log_error(f"Error creating Payment Entry: {str(e)}",
							 "Payment Entry Creation Error")
			raise


def create_sales_invoice_payment_entry(payment_doc, transaction_details):
	"""Create Payment Entry for Sales Invoice"""

	# Check if payment entry already exists
	existing_payment = frappe.db.exists("Payment Entry", {
		"reference_no": payment_doc.receipt_number,
		"docstatus": 1
	})

	if existing_payment:
		frappe.logger().info(f"Payment Entry already exists: {existing_payment}")
		return

	try:
		sales_invoice = frappe.get_doc("Sales Invoice", payment_doc.sales_invoice)

		# Get M-Pesa account - ensure this account exists in Chart of Accounts
		mpesa_account = get_mpesa_account()

		payment_entry = frappe.new_doc("Payment Entry")
		payment_entry.payment_type = "Receive"
		payment_entry.party_type = "Customer"
		payment_entry.party = sales_invoice.customer
		payment_entry.company = sales_invoice.company
		payment_entry.posting_date = frappe.utils.today()
		payment_entry.paid_to = mpesa_account
		payment_entry.paid_amount = payment_doc.amount
		payment_entry.received_amount = payment_doc.amount
		payment_entry.target_exchange_rate = 1
		payment_entry.reference_no = payment_doc.receipt_number
		payment_entry.reference_date = frappe.utils.today()
		payment_entry.mode_of_payment = "M-Pesa Express"

		# Add reference to Sales Invoice
		payment_entry.append("references", {
			"reference_doctype": "Sales Invoice",
			"reference_name": sales_invoice.name,
			"due_date": sales_invoice.due_date,
			"total_amount": sales_invoice.grand_total,
			"outstanding_amount": sales_invoice.outstanding_amount,
			"allocated_amount": payment_doc.amount
		})

		payment_entry.insert(ignore_permissions=True)
		payment_entry.submit()

		frappe.logger().info(
			f"Payment Entry created: {payment_entry.name} for Sales Invoice: {sales_invoice.name}")

	except Exception as e:
		frappe.log_error(f"Payment Entry creation failed: {str(e)}", "Payment Entry Error")
		raise


def get_mpesa_account():
	"""Get M-Pesa account from Chart of Accounts"""

	# Try to find M-Pesa account
	mpesa_accounts = frappe.get_all("Account",
									filters={
										"account_name": ["like", "%mpesa%"],
										"is_group": 0,
										"disabled": 0
									},
									fields=["name"]
									)

	if mpesa_accounts:
		return mpesa_accounts[0].name

	# Fallback to default cash account
	company = frappe.defaults.get_user_default("Company")
	cash_account = frappe.get_value("Company", company, "default_cash_account")

	if cash_account:
		return cash_account

	# Last resort - get any cash account
	cash_accounts = frappe.get_all("Account",
								   filters={
									   "account_type": "Cash",
									   "is_group": 0,
									   "disabled": 0
								   },
								   fields=["name"],
								   limit=1
								   )

	if cash_accounts:
		return cash_accounts[0].name

	frappe.throw(
		"No suitable account found for M-Pesa payments. Please create an M-Pesa account in Chart of Accounts.")


@frappe.whitelist()
def get_payment_status(checkout_request_id):
	"""Manual payment status check for troubleshooting"""
	try:
		payment_doc = frappe.get_doc("Mpesa Payment", {"checkout_request_id": checkout_request_id})
		return {
			"status": payment_doc.status,
			"receipt_number": payment_doc.receipt_number,
			"result_desc": payment_doc.result_desc,
			"amount": payment_doc.amount,
			"phone_number": payment_doc.phone_number
		}
	except Exception as e:
		return {"error": str(e)}


@frappe.whitelist()
def resend_stk_push(checkout_request_id):
	"""Resend STK Push for failed payments"""
	try:
		payment_doc = frappe.get_doc("Mpesa Payment", {"checkout_request_id": checkout_request_id})

		if payment_doc.status == "Completed":
			return {"error": "Payment already completed"}

		# Get original invoice
		invoice_name = payment_doc.pos_invoice or payment_doc.sales_invoice
		invoice_doctype = "POS Invoice" if payment_doc.pos_invoice else "Sales Invoice"

		# Cancel old payment record
		payment_doc.status = "Cancelled"
		payment_doc.save(ignore_permissions=True)

		# Create new STK Push
		return initiate_stk_push(
			payment_doc.phone_number,
			payment_doc.amount,
			pos_invoice_name=payment_doc.pos_invoice,
			sales_invoice_name=payment_doc.sales_invoice
		)

	except Exception as e:
		frappe.log_error(f"Resend STK Push error: {str(e)}", "M-Pesa Resend Error")
		return {"error": str(e)}


@frappe.whitelist(allow_guest=True)
def mpesa_callback():
	"""Simple M-Pesa callback handler"""
	try:
		if frappe.request.method != "POST":
			return {"status": "error", "message": "Only POST allowed"}

		data = json.loads(frappe.request.data)
		callback_metadata = data.get("Body", {}).get("stkCallback", {})

		result_code = callback_metadata.get("ResultCode")
		checkout_request_id = callback_metadata.get("CheckoutRequestID")

		# Find payment record
		payment_doc_name = frappe.get_value("Mpesa Payment",
											{"checkout_request_id": checkout_request_id})
		if not payment_doc_name:
			return {"status": "error", "message": "Payment not found"}

		payment_doc = frappe.get_doc("Mpesa Payment", payment_doc_name)

		if result_code == 0:
			payment_doc.status = "Completed"
			# Extract receipt number
			for item in callback_metadata.get("CallbackMetadata", {}).get("Item", []):
				if item.get("Name") == "MpesaReceiptNumber":
					payment_doc.receipt_number = item.get("Value")
		else:
			payment_doc.status = "Failed"

		payment_doc.save(ignore_permissions=True)
		frappe.db.commit()

		return {"status": "success"}

	except Exception as e:
		frappe.log_error(str(e), "M-Pesa Callback Error")
		return {"status": "error", "message": str(e)}
